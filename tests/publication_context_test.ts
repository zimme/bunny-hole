import { parseDocument } from "npm:yaml@2.9.0";
import {
  assertPublicationContext,
  PUBLICATION_ENVIRONMENT,
  publicationStepFailures,
  workflowEnvironmentFailures,
} from "../scripts/publication_context.ts";
import { publishPackage } from "../scripts/publish_package.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("release forwarding supplies publisher context without exposing runner credentials elsewhere", async () => {
  const workflow = parseDocument(
    await Deno.readTextFile(".github/workflows/release.yml"),
  ).toJS();
  assertEquals(
    workflowEnvironmentFailures(workflow, ".github/workflows/release.yml"),
    [],
  );
  const deployment = parseDocument(
    await Deno.readTextFile(".github/workflows/deploy-bunny.yml"),
  ).toJS();
  assertEquals(
    workflowEnvironmentFailures(deployment, ".github/workflows/deploy-bunny.yml"),
    [],
  );
  for (
    const [path, job, allowed] of [
      [".github/workflows/release.yml", "release", "Release"],
      [".github/workflows/deploy-bunny.yml", "deploy", "Bunny"],
    ]
  ) {
    assert(workflowEnvironmentFailures({}, path).length > 0);
    assert(workflowEnvironmentFailures({ jobs: {} }, path).length > 0);
    for (const environment of [allowed, { name: allowed }]) {
      assertEquals(
        workflowEnvironmentFailures({ jobs: { [job]: { environment } } }, path),
        [],
      );
    }
    for (
      const environment of [undefined, {}, "unprotected", "release", {
        name: "RELEASE",
      }]
    ) {
      assert(
        workflowEnvironmentFailures({ jobs: { [job]: { environment } } }, path).length >
          0,
      );
    }
  }
  assertEquals(workflowEnvironmentFailures({}, ".github/workflows/ci.yml"), []);
  for (
    const environment of [
      "Release",
      "release",
      { name: "RELEASE" },
      "Bunny",
      "bunny",
      { name: "BUNNY" },
    ]
  ) {
    assert(
      workflowEnvironmentFailures(
        { jobs: { validate: { environment } } },
        ".github/workflows/ci.yml",
      ).length > 0,
    );
  }
  const steps = workflow.jobs.release.steps as Record<string, unknown>[];
  const publish = steps.find((step) =>
    (step.with as Record<string, unknown> | undefined)?.runCmd ===
      "deno task release:publish-package"
  );
  assert(publish);
  for (const step of steps) assertEquals(publicationStepFailures(step), []);
  const manifest = JSON.parse(await Deno.readTextFile("deno.json"));
  assertEquals(
    manifest.tasks["release:publish-package"],
    `deno run --allow-env=${
      ["RELEASE_TAG", ...PUBLICATION_ENVIRONMENT].join(",")
    } --allow-net=jsr.io --allow-read=. --allow-run=deno scripts/publish_package.ts`,
  );

  const inputs = publish.with as Record<string, unknown>;
  for (const name of PUBLICATION_ENVIRONMENT) {
    const env = String(inputs.env).split("\n").filter((entry) => entry.trim() !== name)
      .join("\n");
    assert(
      publicationStepFailures({ ...publish, with: { ...inputs, env } }).length > 0,
    );
  }
  for (const inheritEnv of [true, "true"]) {
    assert(
      publicationStepFailures({ ...publish, with: { ...inputs, inheritEnv } }).length >
        0,
    );
  }
  assert(
    publicationStepFailures({
      ...publish,
      with: { ...inputs, env: `${inputs.env}\nNPM_TOKEN` },
    }).length > 0,
  );
  assert(
    publicationStepFailures({
      ...publish,
      with: { ...inputs, runCmd: "deno task validate" },
    }).length > 0,
  );
});

Deno.test("publisher refuses missing or mismatched identity context before registry effects", () => {
  const version = "1.0.0-rc.1";
  const context = publicationContext(version);
  assertPublicationContext(version, (name) => context[name]);
  for (const name of PUBLICATION_ENVIRONMENT) {
    for (const missing of [undefined, "", " "]) {
      assertThrows(
        () =>
          assertPublicationContext(
            version,
            (key) => key === name ? missing : context[key],
          ),
        /Missing publication context/,
      );
    }
  }
  for (
    const [name, value] of Object.entries({
      GITHUB_ACTIONS: "false",
      RUNNER_ENVIRONMENT: "self-hosted",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/tags/1.0.0-rc.2",
      GITHUB_WORKFLOW_REF: "zimme/bunny-hole/.github/workflows/ci.yml@refs/heads/main",
    })
  ) {
    assertThrows(
      () =>
        assertPublicationContext(version, (key) => key === name ? value : context[key]),
      /tagged release workflow/,
    );
  }
});

Deno.test("publisher validates identity, releases registry bodies and publishes only missing JSR versions", async () => {
  const version = "1.0.0-rc.1";
  const context = publicationContext(version);
  for (const status of [200, 404, 503]) {
    const effects: string[] = [];
    const dependencies = {
      fetch: ((input, init) => {
        assertEquals(
          String(input),
          `https://jsr.io/@zimme/bunny-hole/${version}_meta.json`,
        );
        assert(init?.signal instanceof AbortSignal);
        effects.push("check");
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                effects.push("cancel");
              },
            }),
            { status },
          ),
        );
      }) as typeof fetch,
      run: (command: string, args: string[]) => {
        assertEquals([command, ...args], ["deno", "publish"]);
        effects.push("publish");
        return Promise.resolve();
      },
    };
    await assertRejects(
      () => publishPackage(version, () => undefined, dependencies),
      /Missing publication context/,
    );
    assertEquals(effects, []);
    const publish = () =>
      publishPackage(version, (name) => context[name], dependencies);
    if (status === 503) await assertRejects(publish, /HTTP 503/);
    else await publish();
    assertEquals(
      effects,
      status === 404 ? ["check", "cancel", "publish"] : ["check", "cancel"],
    );
  }
  let invoked = false;
  await assertRejects(() =>
    publishPackage(version, (name) => context[name], {
      fetch: () => Promise.reject(new Error("registry unavailable")),
      run: () => {
        invoked = true;
        return Promise.resolve();
      },
    }), /registry unavailable/);
  assert(!invoked);
  await assertRejects(() =>
    publishPackage(version, (name) => context[name], {
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      run: () => Promise.reject(new Error("publication failed")),
    }), /publication failed/);
});

function publicationContext(version: string): Record<string, string> {
  const context: Record<string, string> = Object.fromEntries(
    PUBLICATION_ENVIRONMENT.map((name) => [name, "test-value"]),
  );
  Object.assign(context, {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: `refs/tags/${version}`,
    GITHUB_REPOSITORY: "zimme/bunny-hole",
    GITHUB_WORKFLOW_REF:
      `zimme/bunny-hole/.github/workflows/release.yml@refs/tags/${version}`,
  });
  return context;
}

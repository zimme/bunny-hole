import { parseDocument } from "npm:yaml@2.9.0";
import {
  assertPublicationContext,
  PUBLICATION_ENVIRONMENT,
  publicationStepFailures,
} from "../scripts/publication_context.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";

Deno.test("release forwarding supplies publisher context without exposing runner credentials elsewhere", async () => {
  const workflow = parseDocument(
    await Deno.readTextFile(".github/workflows/release.yml"),
  ).toJS();
  const steps = workflow.jobs.release.steps as Record<string, unknown>[];
  const publish = steps.find((step) =>
    (step.with as Record<string, unknown> | undefined)?.runCmd ===
      "deno task release:publish-package"
  );
  assert(publish);
  for (const step of steps) assertEquals(publicationStepFailures(step), []);
  const manifest = JSON.parse(await Deno.readTextFile("deno.json"));
  const permissions = manifest.tasks["release:publish-package"].match(
    /--allow-env=(\S+)/,
  )[1].split(",");
  for (const name of PUBLICATION_ENVIRONMENT) assert(permissions.includes(name));

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

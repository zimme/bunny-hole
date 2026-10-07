import { dirname, join } from "node:path";
import { parseDocument } from "npm:yaml@2.9.0";
import { assert, assertEquals } from "./assert.ts";

// cspell:words gpgsign

Deno.test("release SBOM staging preserves a clean publishable checkout", async () => {
  const workflow = parseDocument(
    await Deno.readTextFile(".github/workflows/release.yml"),
  ).toJS();
  const steps = workflow.jobs.release.steps as Record<string, unknown>[];
  const outputs = steps.filter((step) =>
    typeof (step.with as Record<string, unknown> | undefined)?.["output-file"] ===
      "string"
  ).map((step) => String((step.with as Record<string, unknown>)["output-file"]));
  assertEquals(outputs.length, 2);
  const attestations = steps.filter((step) =>
    typeof (step.with as Record<string, unknown> | undefined)?.["sbom-path"] ===
      "string"
  ).map((step) => String((step.with as Record<string, unknown>)["sbom-path"]));
  const release = steps.find((step) => step.name === "Create GitHub release");

  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(directory, ".gitignore"),
      await Deno.readTextFile(".gitignore"),
    );
    await Deno.writeTextFile(
      join(directory, "deno.json"),
      JSON.stringify({
        name: "@zimme/bunny-hole",
        version: "1.0.0-rc.4",
        exports: "./mod.ts",
        license: "MIT",
        publish: { include: ["mod.ts"] },
      }),
    );
    await Deno.writeTextFile(join(directory, "mod.ts"), "export const value = 1;\n");
    const command = (program: string, args: string[]) =>
      new Deno.Command(program, {
        args,
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
    for (
      const args of [
        ["init"],
        ["add", "."],
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "fixture",
        ],
      ]
    ) {
      const result = await command("git", args);
      assert(result.success, new TextDecoder().decode(result.stderr));
    }
    for (const output of outputs) {
      const path = output.replaceAll("${{ github.ref_name }}", "1.0.0-rc.4");
      assert(!path.includes("..") && !path.startsWith("/"));
      const destination = join(directory, path);
      await Deno.mkdir(dirname(destination), { recursive: true });
      await Deno.writeTextFile(destination, "{}\n");
    }
    const native = "dist/release/bunny-hole-fixture.tar.gz";
    await Deno.mkdir(join(directory, "dist/release"), { recursive: true });
    await Deno.writeTextFile(join(directory, native), "native bundle fixture\n");
    const status = await command("git", ["status", "--porcelain"]);
    assert(status.success);
    assertEquals(new TextDecoder().decode(status.stdout), "");
    const publish = () => command(Deno.execPath(), ["publish", "--dry-run"]);
    const clean = await publish();
    assert(clean.success, new TextDecoder().decode(clean.stderr));

    await Deno.writeTextFile(join(directory, "mod.ts"), "export const value = 2;\n");
    const dirty = await publish();
    assert(!dirty.success);
    assert(new TextDecoder().decode(dirty.stderr).includes("uncommitted changes"));
    assertEquals(attestations.sort(), [...outputs].sort());
    for (const output of outputs) assertEquals(dirname(output), "dist/release-sboms");
    const initialize = steps.find((step) =>
      step.name === "Initialize runner-owned SBOM output"
    );
    assertEquals(initialize?.run, "mkdir -p dist/release-sboms");
    assert(
      steps.indexOf(initialize!) <
        steps.findIndex((step) =>
          typeof (step.with as Record<string, unknown> | undefined)?.["output-file"] ===
            "string"
        ),
    );
    const fileAttestation = steps.find((step) => step.name === "Attest release files");
    assertEquals(
      String((fileAttestation?.with as Record<string, unknown>)["subject-path"])
        .trim().split(/\s+/).sort(),
      ["dist/release-sboms/*", "dist/release/*"],
    );

    // Execute the workflow's actual attachment command with publication replaced
    // by an argument recorder. Obsolete root paths and duplicates must fail too.
    assert(typeof release?.run === "string");
    const bin = join(directory, ".tmp", "bin");
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const upload = await new Deno.Command("bash", {
      args: ["-c", release.run],
      cwd: directory,
      clearEnv: true,
      env: { PATH: `${bin}:${Deno.env.get("PATH")}`, RELEASE_TAG: "1.0.0-rc.4" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(upload.success, new TextDecoder().decode(upload.stderr));
    const args = new TextDecoder().decode(upload.stdout).trim().split("\n");
    assertEquals(args.slice(0, 3), ["release", "create", "1.0.0-rc.4"]);
    assertEquals(
      args.slice(3, args.indexOf("--verify-tag")).sort(),
      [
        ...outputs.map((path) =>
          path.replaceAll("${{ github.ref_name }}", "1.0.0-rc.4")
        ),
        native,
      ].sort(),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

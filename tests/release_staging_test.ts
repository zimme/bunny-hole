import { dirname, join } from "node:path";
import { parseDocument } from "npm:yaml@2.9.0";
import { assert, assertEquals } from "./assert.ts";

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
    async function command(program: string, args: string[]) {
      return await new Deno.Command(program, {
        args,
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
    }
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
    assert(String(release?.run).includes("dist/release/*"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

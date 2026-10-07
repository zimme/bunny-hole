import { parseDocument } from "npm:yaml@2.9.0";
import { assert, assertEquals } from "./assert.ts";

Deno.test("development Git configuration trusts only the mounted checkout and disables host fsmonitor", async () => {
  const compose = parseDocument(await Deno.readTextFile("compose.yaml")).toJS();
  const directory = await Deno.makeTempDir();
  try {
    const config = `${directory}/gitconfig`;
    await Deno.writeTextFile(config, "");
    const env = {
      ...Object.fromEntries(
        Object.entries(compose.services.development.environment).filter(([key]) =>
          key.startsWith("GIT_CONFIG_")
        ),
      ),
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_GLOBAL: config,
    } as Record<string, string>;
    for (
      const [key, expected] of [
        ["safe.directory", "/workspaces/bunny-hole\n"],
        ["core.fsmonitor", "false\n"],
      ]
    ) {
      const result = await new Deno.Command("git", {
        args: ["config", "--get-all", key],
        cwd: directory,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
      assertEquals(
        new TextDecoder().decode(result.stdout).replaceAll("\r\n", "\n"),
        expected,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

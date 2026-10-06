import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "./assert.ts";

Deno.test("release gate sees descendant tags and requires an ancestral stable baseline", async () => {
  const directory = await Deno.makeTempDir({ prefix: "bunny-release-history-" });
  const script = fileURLToPath(new URL("../scripts/release_check.ts", import.meta.url));
  async function git(...args: string[]): Promise<string> {
    const result = await new Deno.Command("git", {
      args: [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release@example.test",
        ...args,
      ],
      cwd: directory,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  async function version(value: string): Promise<void> {
    await Deno.writeTextFile(
      `${directory}/deno.json`,
      JSON.stringify({ version: value }),
    );
    await Deno.writeTextFile(
      `${directory}/packages/api/mod.ts`,
      `export const VERSION = "${value}";`,
    );
    await Deno.writeTextFile(
      `${directory}/docs/openapi.yaml`,
      `info:\n  version: ${value}\n`,
    );
  }
  async function check(value: string, failure?: RegExp): Promise<void> {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", "--allow-run=git", script, value],
      cwd: directory,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.success, !failure);
    if (failure) assert(failure.test(new TextDecoder().decode(result.stderr)));
  }
  try {
    await Deno.mkdir(`${directory}/packages/api`, { recursive: true });
    await Deno.mkdir(`${directory}/docs`);
    await git("init", "--initial-branch=main");
    await version("1.0.0");
    await git("add", ".");
    await git("commit", "-m", "feat: first stable release");
    await git("tag", "1.0.0");
    await version("1.1.0-rc.1");
    await git("commit", "-am", "feat: next candidate");
    const candidateCommit = await git("rev-parse", "HEAD");
    await check("1.1.0-rc.1");
    await git("tag", "1.1.0-rc.1");
    await version("1.1.0-rc.2");
    await git("commit", "-am", "fix: refine candidate");
    await check("1.1.0-rc.2");
    await git("tag", "1.1.0-rc.2");
    await version("1.1.0");
    await git("commit", "-am", "feat: promote candidate");
    await check("1.1.0");
    await git("tag", "1.1.0");
    await git("checkout", "--detach", candidateCommit);
    await check("1.1.0-rc.1", /increase across all release tags/);
    await version("1.2.0");
    await git("commit", "-am", "feat: divergent release");
    await check("1.2.0", /stable release must be an ancestor/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

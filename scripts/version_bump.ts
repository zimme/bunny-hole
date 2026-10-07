import { compareReleaseVersion, parseReleaseVersion } from "./comver.ts";
import { readProductVersion } from "./version_check.ts";

/** Update required product metadata together; runtime versions remain immutable. */
export async function bumpProductVersion(
  version: string,
  root = ".",
  writeFile: (path: string, source: string) => Promise<void> = Deno.writeTextFile,
): Promise<void> {
  const target = parseReleaseVersion(version);
  const previous = await readProductVersion(root);
  if (compareReleaseVersion(target, parseReleaseVersion(previous)) <= 0) {
    throw new Error(
      "product version must increase; repeated versions and downgrades are forbidden",
    );
  }
  const markers = new Map([
    ["deno.json", [`"version": "${previous}"`, `"version": "${version}"`]],
    ["packages/api/mod.ts", [
      `export const VERSION = "${previous}";`,
      `export const VERSION = "${version}";`,
    ]],
    ["docs/openapi.yaml", [`  version: ${previous}`, `  version: ${version}`]],
  ]);
  const originals = new Map<string, string>();
  const updates = new Map<string, string>();
  for (const [path, [before, after]] of markers) {
    const source = await Deno.readTextFile(`${root}/${path}`);
    if (source.split(before).length !== 2) {
      throw new Error(`expected exactly one product version marker in ${path}`);
    }
    originals.set(path, source);
    updates.set(path, source.replace(before, after));
  }
  try {
    for (const [path, source] of updates) {
      await writeFile(`${root}/${path}`, source);
    }
    if (await readProductVersion(root) !== version) {
      throw new Error("version writes did not persist the requested product version");
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const [path, source] of originals) {
      try {
        await writeFile(`${root}/${path}`, source);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    throw new AggregateError(
      failures,
      "version bump failed; originals restored where possible",
    );
  }
}

if (import.meta.main) {
  if (Deno.args.length !== 1) throw new Error("usage: deno task version:bump VERSION");
  await bumpProductVersion(Deno.args[0]);
  console.log(
    `product version updated to ${Deno.args[0]}; run release:check before tagging`,
  );
}

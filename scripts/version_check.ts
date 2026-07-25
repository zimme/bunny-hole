import { parseComVer } from "./comver.ts";

export async function readProductVersion(): Promise<string> {
  const paths = ["apps/connector/main.ts", "apps/relay/main.ts"];
  const versions = new Map<string, string>();

  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const match = source.match(/export const VERSION = "([^"]+)";/);
    if (!match) throw new Error(`product VERSION is missing from ${path}`);
    versions.set(path, match[1]);
  }

  const unique = new Set(versions.values());
  if (unique.size !== 1) {
    throw new Error(
      `product versions differ: ${
        [...versions].map(([path, version]) => `${path}=${version}`).join(", ")
      }`,
    );
  }
  return [...unique][0];
}

if (import.meta.main) {
  const version = await readProductVersion();
  parseComVer(version);
  console.log(`version check: ${version} is valid ComVer`);
}

import { parseComVer } from "./comver.ts";

export async function readProductVersion(): Promise<string> {
  const paths = ["packages/api/mod.ts"];
  const versions = new Map<string, string>();

  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const match = source.match(/export const VERSION = "([^"]+)";/);
    if (!match) throw new Error(`product VERSION is missing from ${path}`);
    versions.set(path, match[1]);
  }

  const manifest = JSON.parse(await Deno.readTextFile("deno.json"));
  versions.set("deno.json", manifest.version);
  const openApi = await Deno.readTextFile("docs/openapi.yaml");
  const openApiVersion = openApi.match(/^[ ]{2}version: ([^\s]+)$/m)?.[1];
  if (!openApiVersion) throw new Error("OpenAPI product version is missing");
  versions.set("docs/openapi.yaml", openApiVersion);
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

async function checkDenoVersion(): Promise<string> {
  const toolVersions = await Deno.readTextFile(".tool-versions");
  const matches = [...toolVersions.matchAll(/^deno\s+(\S+)$/gm)];
  if (matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(matches[0][1])) {
    throw new Error(".tool-versions must declare exactly one stable Deno version");
  }
  const version = matches[0][1];
  const expected = new Map<string, string>([
    ["AGENTS.md", `Use Deno ${version}`],
    ["Dockerfile", `ARG DENO_VERSION=${version}`],
    [".devcontainer/Dockerfile", `ARG DENO_VERSION=${version}`],
    ["compose.yaml", `DENO_VERSION: "${version}"`],
    ["docs/architecture.md", `Deno ${version} is pinned`],
    ["docs/development.md", `Deno ${version} is the only task runner`],
  ]);
  for (const [path, marker] of expected) {
    if (!(await Deno.readTextFile(path)).includes(marker)) {
      throw new Error(`${path} does not use authoritative Deno ${version}`);
    }
  }
  return version;
}

if (import.meta.main) {
  const version = await readProductVersion();
  parseComVer(version);
  const denoVersion = await checkDenoVersion();
  console.log(
    `version check: ${version} is valid ComVer; Deno ${denoVersion} is consistent`,
  );
}

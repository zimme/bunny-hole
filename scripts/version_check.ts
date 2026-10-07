import { parseReleaseVersion } from "./comver.ts";

export async function readProductVersion(root = "."): Promise<string> {
  const paths = ["packages/api/mod.ts"];
  const versions = new Map<string, string>();

  for (const path of paths) {
    const source = await Deno.readTextFile(`${root}/${path}`);
    const match = source.match(/export const VERSION = "([^"]+)";/);
    if (!match) throw new Error(`product VERSION is missing from ${path}`);
    versions.set(path, match[1]);
  }

  const manifest = JSON.parse(await Deno.readTextFile(`${root}/deno.json`));
  versions.set("deno.json", manifest.version);
  const openApi = await Deno.readTextFile(`${root}/docs/openapi.yaml`);
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
  const version = [...unique][0];
  parseReleaseVersion(version);
  return version;
}

export async function checkToolchainVersions(root = "."): Promise<void> {
  const source = await Deno.readTextFile(`${root}/.tool-versions`);
  const expected = new Map<string, string[]>();
  const pins: Record<string, string> = {};
  for (const name of ["deno", "nodejs", "terraform"]) {
    const matches = [...source.matchAll(new RegExp(`^${name}\\s+(\\S+)$`, "gm"))];
    if (matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(matches[0][1])) {
      throw new Error(`.tool-versions must declare exactly one stable ${name} version`);
    }
    pins[name] = matches[0][1];
  }
  expected.set("Dockerfile", [`ARG DENO_VERSION=${pins.deno}`]);
  expected.set(".devcontainer/Dockerfile", [
    `ARG DENO_VERSION=${pins.deno}`,
    `ARG NODE_VERSION=${pins.nodejs}`,
    `ARG TERRAFORM_VERSION=${pins.terraform}`,
  ]);
  expected.set("compose.yaml", [
    `DENO_VERSION: "${pins.deno}"`,
    `NODE_VERSION: "${pins.nodejs}"`,
    `TERRAFORM_VERSION: "${pins.terraform}"`,
  ]);
  expected.set(".github/workflows/ci.yml", [`deno-version: ${pins.deno}`]);
  expected.set("templates/bunny-deployment/.terraform-version", [pins.terraform]);
  expected.set("templates/bunny-deployment/terraform/versions.tf", [
    `required_version = "= ${pins.terraform}"`,
  ]);
  for (const workflow of ["check", "plan", "apply"]) {
    expected.set(`templates/bunny-deployment/.github/workflows/${workflow}.yml`, [
      `terraform_version: ${pins.terraform}`,
    ]);
  }
  for (const [path, markers] of expected) {
    const content = await Deno.readTextFile(`${root}/${path}`);
    for (const marker of markers) {
      if (!content.split("\n").some((line) => line.trim() === marker)) {
        throw new Error(`${path} does not match toolchain pin ${marker}`);
      }
    }
  }
  // Compose must use the same pinned development tools as its image defaults.
  const dockerfile = await Deno.readTextFile(`${root}/.devcontainer/Dockerfile`);
  const compose = await Deno.readTextFile(`${root}/compose.yaml`);
  for (
    const [, name, value] of dockerfile.matchAll(/^ARG ([A-Z_]+_VERSION)=(\S+)$/gm)
  ) {
    if (!compose.includes(`${name}: "${value}"`)) {
      throw new Error(`compose.yaml does not match image toolchain pin ${name}`);
    }
  }
}

if (import.meta.main) {
  const version = await readProductVersion();
  parseReleaseVersion(version);
  await checkToolchainVersions();
  console.log(
    `version check: ${version} is valid ComVer; toolchain pins are consistent`,
  );
}

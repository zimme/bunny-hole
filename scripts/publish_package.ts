import { buildNpmPackage } from "./build_npm_package.ts";
import { output, run } from "./process.ts";
import { parseComVer } from "./comver.ts";
import { readProductVersion } from "./version_check.ts";

const version = Deno.env.get("RELEASE_TAG")?.trim();
if (!version || version !== await readProductVersion()) {
  throw new Error("RELEASE_TAG must match the product version");
}

const jsrUrl = `https://jsr.io/@zimme/bunny-hole/${version}_meta.json`;
if (await versionExists(jsrUrl)) {
  throw new Error(`JSR @zimme/bunny-hole@${version} already exists`);
}

const npmUrl = `https://registry.npmjs.org/${
  encodeURIComponent("@zimme/bunny-hole")
}/${version}`;
const npmVersionExists = await versionExists(npmUrl);
if (npmVersionExists) {
  const otherComVerTags = (await output("git", ["tag", "--list"]))
    .split("\n")
    .filter((tag) => tag && tag !== version)
    .some((tag) => {
      try {
        parseComVer(tag);
        return true;
      } catch {
        return false;
      }
    });
  if (otherComVerTags) {
    throw new Error(`npm @zimme/bunny-hole@${version} already exists`);
  }
  console.log(
    `npm @zimme/bunny-hole@${version} is the documented first-release bootstrap`,
  );
}

await run("deno", ["publish"]);
if (!npmVersionExists) {
  const artifact = await buildNpmPackage("dist/npm");
  await run("npm", ["publish", artifact]);
}

async function versionExists(url: string): Promise<boolean> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`registry check failed with HTTP ${response.status}`);
  }
  return true;
}

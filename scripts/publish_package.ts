import { buildNpmPackage } from "./build_npm_package.ts";
import { run } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

const version = Deno.env.get("RELEASE_TAG")?.trim();
if (!version || version !== await readProductVersion()) {
  throw new Error("RELEASE_TAG must match the product version");
}

const jsrUrl = `https://jsr.io/@zimme/bunny-hole/${version}_meta.json`;
if (await versionExists(jsrUrl)) {
  console.log(`JSR @zimme/bunny-hole@${version} already exists; skipping`);
} else {
  await run("deno", ["publish"]);
}

const npmUrl = `https://registry.npmjs.org/${
  encodeURIComponent("@zimme/bunny-hole")
}/${version}`;
if (await versionExists(npmUrl)) {
  console.log(`npm @zimme/bunny-hole@${version} already exists; skipping`);
} else {
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

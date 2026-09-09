import { buildNpmPackage } from "./build_npm_package.ts";
import { output, run } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

const version = await readProductVersion();

await run("deno", ["publish", "--dry-run", "--allow-dirty"]);
const temporaryDirectory = await Deno.makeTempDir({
  dir: "/tmp",
  prefix: "bunny-hole-package-check-",
});
try {
  const artifact = await buildNpmPackage(temporaryDirectory, true);
  const files = (await output("tar", ["-tzf", artifact])).split("\n");
  const required = [
    "package/LICENSE",
    "package/README.md",
    "package/apps/connector/client.js",
    "package/apps/connector/frpc_config.js",
    "package/apps/connector/library.js",
    "package/apps/connector/mod.js",
    "package/package.json",
    "package/packages/api/auth.js",
    "package/packages/api/mod.js",
  ];
  for (const file of required) {
    if (!files.includes(file)) throw new Error(`npm package is missing ${file}`);
  }
  if (files.some((file) => /apps\/(host|operator)|private|state\.sqlite/.test(file))) {
    throw new Error("npm package contains server or secret-bearing files");
  }

  const extracted = `${temporaryDirectory}/inspect`;
  await Deno.mkdir(extracted);
  await run("tar", ["-xzf", artifact, "-C", extracted]);
  const manifest = JSON.parse(
    await Deno.readTextFile(`${extracted}/package/package.json`),
  );
  if (
    manifest.name !== "@zimme/bunny-hole" ||
    manifest.repository?.url !== "git+https://github.com/zimme/bunny-hole.git" ||
    manifest.publishConfig?.access !== "public" || manifest.scripts !== undefined ||
    manifest.dependencies !== undefined
  ) throw new Error("npm package metadata is incomplete or unsafe");

  const consumer = `${temporaryDirectory}/consumer`;
  await Deno.mkdir(consumer);
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefix",
    consumer,
    artifact,
  ], {
    env: {
      NPM_CONFIG_CACHE: `${temporaryDirectory}/npm-cache`,
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    },
  });
  const smoke = `${consumer}/smoke.mjs`;
  await Deno.writeTextFile(
    smoke,
    `
import { BunnyHoleClient, createConnector, generateKeyPair, VERSION } from "@zimme/bunny-hole";
if (VERSION !== ${
      JSON.stringify(version)
    }) throw new Error("unexpected package version");
const keys = await generateKeyPair();
if (!keys.privateKey || !keys.publicKey) throw new Error("key generation failed");
let rejected = false;
try { new BunnyHoleClient("http://insecure.example"); } catch { rejected = true; }
if (!rejected) throw new Error("insecure host URL was accepted");
let pathRejected = false;
try { createConnector({ credentials: {}, frpcPath: "" }); } catch { pathRejected = true; }
if (!pathRejected) throw new Error("missing frpc executable was accepted");
`,
  );
  await run("node", [smoke], { cwd: consumer });
  const typeSmoke = `${consumer}/type-smoke.ts`;
  await Deno.writeTextFile(
    typeSmoke,
    `
import { BunnyHoleClient, createConnector, type HostCredentials, type Route } from "@zimme/bunny-hole";
const client = new BunnyHoleClient("https://hole.example.com");
const credentials = {} as HostCredentials;
const routes = [] as Route[];
void client; void credentials; void routes;
void createConnector;
`,
  );
  await run("deno", ["check", "--node-modules-dir=manual", typeSmoke], {
    cwd: consumer,
  });
  console.log("JSR dry run and isolated npm consumer checks passed.");
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

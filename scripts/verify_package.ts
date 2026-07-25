import { buildNpmPackage } from "./build_npm_package.ts";
import { output, run } from "./process.ts";
import { loadRelayConfig } from "../apps/relay/config.ts";
import { Relay } from "../apps/relay/relay.ts";
import { createSecret } from "../packages/protocol/auth.ts";

const EXPECTED_FILES = [
  "package/LICENSE",
  "package/README.md",
  "package/apps/connector/connector.d.ts",
  "package/apps/connector/connector.js",
  "package/apps/connector/library.d.ts",
  "package/apps/connector/library.js",
  "package/apps/connector/mod.d.ts",
  "package/apps/connector/mod.js",
  "package/apps/edge-relay/mod.d.ts",
  "package/apps/edge-relay/mod.js",
  "package/apps/edge-relay/relay.d.ts",
  "package/apps/edge-relay/relay.js",
  "package/apps/relay/config.d.ts",
  "package/apps/relay/config.js",
  "package/apps/relay/logger.d.ts",
  "package/apps/relay/logger.js",
  "package/apps/relay/relay.d.ts",
  "package/apps/relay/relay.js",
  "package/package.json",
  "package/packages/protocol/auth.js",
  "package/packages/protocol/mod.js",
  "package/packages/protocol/security.js",
].sort();

await run("deno", ["publish", "--dry-run", "--allow-dirty"]);

const temporaryDirectory = await Deno.makeTempDir({
  dir: "/tmp",
  prefix: "bunny-hole-package-check-",
});
try {
  const artifact = await buildNpmPackage(temporaryDirectory, true);
  const files = (await output("tar", ["-tzf", artifact])).split("\n").sort();
  if (files.join("\n") !== EXPECTED_FILES.join("\n")) {
    throw new Error(
      `npm package contents differ from the allowlist\nActual:\n${files.join("\n")}`,
    );
  }

  const extracted = `${temporaryDirectory}/inspect`;
  await Deno.mkdir(extracted);
  await run("tar", ["-xzf", artifact, "-C", extracted]);
  const manifest = JSON.parse(
    await Deno.readTextFile(`${extracted}/package/package.json`),
  );
  if (
    manifest.name !== "@zimme/bunny-hole" ||
    manifest.repository?.url !==
      "git+https://github.com/zimme/bunny-hole.git" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.scripts !== undefined ||
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
    `import { createConnector, VERSION } from "@zimme/bunny-hole";
import { createEdgeRelayHandler } from "@zimme/bunny-hole/edge-relay";
if (VERSION !== "0.1.0") throw new Error("unexpected package version");
if (typeof createEdgeRelayHandler !== "function") {
  throw new Error("edge relay export is unavailable");
}
const options = {
  relayUrl: "wss://relay.example",
  tunnelId: "example-tunnel",
  secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const connector = createConnector(options);
if (typeof connector.run !== "function" || typeof connector.stop !== "function") {
  throw new Error("connector lifecycle API is incomplete");
}
connector.stop();
let rejected = false;
try {
  createConnector({ ...options, relayUrl: "ws://relay.example" });
} catch {
  rejected = true;
}
if (!rejected) throw new Error("insecure relay URL was accepted");
`,
  );
  await run("node", [smoke], { cwd: consumer });
  await verifyNodeConnectorTraffic(consumer);
  console.log("JSR dry run and isolated npm consumer checks passed.");
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function verifyNodeConnectorTraffic(consumer: string): Promise<void> {
  const originPort = freePort();
  const relayPort = freePort();
  const secret = createSecret();
  const originAbort = new AbortController();
  const relayAbort = new AbortController();
  const origin = Deno.serve({
    hostname: "127.0.0.1",
    port: originPort,
    signal: originAbort.signal,
    onListen() {},
  }, async (request) => {
    const body = await request.text();
    return Response.json({
      body,
      internalHeader: request.headers.get("x-bunny-hole-secret"),
    });
  });
  const relayConfig = loadRelayConfig({
    HOST: "127.0.0.1",
    PORT: String(relayPort),
    BUNNY_HOLE_LOCAL_DEVELOPMENT: "true",
    BUNNY_HOLE_TUNNELS: JSON.stringify([{
      id: "npm-consumer",
      secret,
      hostnames: ["127.0.0.1"],
    }]),
  });
  const relay = new Relay(relayConfig, {
    info() {},
    warn() {},
    error() {},
  });
  const relayServer = Deno.serve({
    hostname: "127.0.0.1",
    port: relayPort,
    signal: relayAbort.signal,
    onListen() {},
  }, (request, info) => relay.handle(request, info));
  const networkSmoke = `${consumer}/network-smoke.mjs`;
  await Deno.writeTextFile(
    networkSmoke,
    `import { createConnector } from "@zimme/bunny-hole";
const abort = new AbortController();
const connector = createConnector({
  relayUrl: process.env.TEST_RELAY_URL,
  tunnelId: "npm-consumer",
  secret: process.env.TEST_TUNNEL_SECRET,
  origin: process.env.TEST_ORIGIN_URL,
  localDevelopment: true,
  logger: {
    info(event, fields) { console.error(JSON.stringify({ event, fields })); },
    warn(event, fields) { console.error(JSON.stringify({ event, fields })); },
    error(event, fields) { console.error(JSON.stringify({ event, fields })); },
  },
});
process.once("SIGTERM", () => abort.abort());
await connector.run(abort.signal);
`,
  );
  const child = new Deno.Command("node", {
    args: [networkSmoke],
    cwd: consumer,
    env: {
      TEST_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
      TEST_TUNNEL_SECRET: secret,
      TEST_ORIGIN_URL: `http://127.0.0.1:${originPort}`,
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let childStatus: Deno.CommandStatus | undefined;
  try {
    await waitUntil(() => relay.sessions.has("npm-consumer"));
    const response = await fetch(`http://127.0.0.1:${relayPort}/npm`, {
      method: "POST",
      headers: { "x-bunny-hole-secret": secret },
      body: "node-library-traffic",
    });
    const result = await response.json();
    if (
      response.status !== 200 ||
      result.body !== "node-library-traffic" ||
      result.internalHeader !== null
    ) {
      throw new Error(
        `Node connector library traffic check failed: ${
          JSON.stringify({
            status: response.status,
            bodyMatches: result.body === "node-library-traffic",
            internalHeaderPresent: result.internalHeader !== null,
          })
        }`,
      );
    }
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already exited; its status below still records the failure.
    }
    childStatus = await child.status;
    relay.shutdown();
    relayAbort.abort();
    originAbort.abort();
    await Promise.all([relayServer.finished, origin.finished]);
  }
  if (!childStatus?.success) {
    throw new Error("Node connector consumer exited unsuccessfully");
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Node connector authentication timed out");
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

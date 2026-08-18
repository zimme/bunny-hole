import { generateTunnelKeyPair } from "../packages/protocol/auth.ts";
import { output, run } from "./process.ts";

await run("docker", [
  "build",
  "--target",
  "relay-runtime",
  "-t",
  "bunny-hole-relay:local",
  ".",
]);
await run("docker", [
  "build",
  "--target",
  "connector-runtime",
  "-t",
  "bunny-hole-connector:local",
  ".",
]);
const connectorUser = await output("docker", [
  "inspect",
  "--format",
  "{{.Config.User}}",
  "bunny-hole-connector:local",
]);
if (!connectorUser || connectorUser === "0" || connectorUser === "root") {
  throw new Error("connector runs as root");
}
await run("docker", [
  "run",
  "--rm",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "bunny-hole-connector:local",
  "--version",
]);
const { publicKey } = await generateTunnelKeyPair();
const bindAddress = Deno.env.get("BUNNY_HOLE_BIND_ADDRESS") ?? "127.0.0.1";
const testHost = Deno.env.get("BUNNY_HOLE_TEST_HOST") ?? "127.0.0.1";
const tunnels = JSON.stringify([{
  id: "smoke",
  publicKey,
  hostnames: ["smoke.test"],
}]);
const id = (await output("docker", [
  "run",
  "--detach",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--publish",
  `${bindAddress}:18081:8080`,
  "--env",
  "BUNNY_HOLE_TUNNELS",
  "bunny-hole-relay:local",
], { env: { ...Deno.env.toObject(), BUNNY_HOLE_TUNNELS: tunnels } })).trim();
try {
  const user = await output("docker", ["inspect", "--format", "{{.Config.User}}", id]);
  if (!user || user === "0" || user === "root") throw new Error("relay runs as root");
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const response = await fetch(`http://${testHost}:18081/healthz`);
      if (response.ok) break;
    } catch {
      // Container is starting.
    }
    if (Date.now() > deadline) throw new Error("relay health check timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(
    `container smoke: relay healthy as ${user}; connector runs as ${connectorUser}`,
  );
} finally {
  await run("docker", ["stop", "--timeout", "2", id]).catch(() => {});
  await run("docker", ["rm", id]).catch(() => {});
}

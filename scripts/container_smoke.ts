import { generateKeyPair } from "../packages/api/auth.ts";
import { output, run } from "./process.ts";

await run("docker", [
  "build",
  "--target",
  "host-runtime",
  "-t",
  "bunny-hole-host:local",
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
for (const image of ["bunny-hole-host:local", "bunny-hole-connector:local"]) {
  const user = await output("docker", [
    "inspect",
    "--format",
    "{{.Config.User}}",
    image,
  ]);
  if (!user || user === "0" || user === "root") {
    throw new Error(`${image} runs as root`);
  }
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
const owner = await generateKeyPair();
const bindAddress = Deno.env.get("BUNNY_HOLE_BIND_ADDRESS") ?? "127.0.0.1";
const testHost = Deno.env.get("BUNNY_HOLE_TEST_HOST") ?? "127.0.0.1";
const id = (await output("docker", [
  "run",
  "--detach",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--tmpfs",
  "/tmp:size=16m,noexec,nosuid",
  "--mount",
  "type=volume,destination=/var/lib/bunny-hole",
  "--publish",
  `${bindAddress}:18081:8080`,
  "--env",
  "BUNNY_HOLE_LOCAL_DEVELOPMENT=true",
  "--env",
  "BUNNY_HOLE_PUBLIC_URL=http://127.0.0.1:8080",
  "--env",
  `BUNNY_HOLE_OWNER_PUBLIC_KEY=${owner.publicKey}`,
  "bunny-hole-host:local",
])).trim();
try {
  const user = await output("docker", ["inspect", "--format", "{{.Config.User}}", id]);
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      const response = await fetch(`http://${testHost}:18081/readyz`);
      if (response.ok) break;
    } catch {
      // Container is starting.
    }
    if (Date.now() > deadline) throw new Error("host readiness check timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(
    `container smoke: host ready as ${user}; connector is non-root and runnable`,
  );
} finally {
  await run("docker", ["rm", "--force", "--volumes", id]);
}

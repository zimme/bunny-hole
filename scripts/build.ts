import { run } from "./process.ts";

await Deno.mkdir("dist", { recursive: true });
await run("deno", [
  "compile",
  "--frozen",
  "--allow-env=BUNNY_HOLE_LOCAL_DEVELOPMENT,BUNNY_HOLE_ALLOW_PRIVATE_NETWORK,BUNNY_HOLE_RELAY_URL,BUNNY_HOLE_TUNNEL_ID,BUNNY_HOLE_TUNNEL_SECRET,BUNNY_HOLE_ORIGIN,BUNNY_HOLE_LOG_FORMAT",
  "--allow-net",
  "--allow-read",
  "--output",
  "dist/bunny-hole",
  "apps/connector/main.ts",
]);
await run("deno", [
  "compile",
  "--frozen",
  "--allow-env=HOST,PORT,BUNNY_HOLE_LOCAL_DEVELOPMENT,BUNNY_HOLE_LOG_FORMAT,BUNNY_HOLE_TUNNELS",
  "--allow-net",
  "--output",
  "dist/bunny-hole-relay",
  "apps/relay/main.ts",
]);

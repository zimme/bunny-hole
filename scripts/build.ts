import { run } from "./process.ts";

await Deno.mkdir("dist", { recursive: true });
const permissions = [
  "--allow-env",
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-sys",
];
await run("deno", [
  "compile",
  "--config",
  "deno.runtime.json",
  "--frozen",
  ...permissions,
  "--output",
  "dist/bunny-hole",
  "apps/connector/main.ts",
]);
await run("deno", [
  "compile",
  "--config",
  "deno.runtime.json",
  "--frozen",
  ...permissions,
  "--output",
  "dist/bunny-hole-host",
  "apps/host/main.ts",
]);

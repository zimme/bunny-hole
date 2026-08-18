import { run } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

const targets = [
  ["x86_64-unknown-linux-gnu", "bunny-hole-linux-x86_64"],
  ["aarch64-unknown-linux-gnu", "bunny-hole-linux-aarch64"],
  ["x86_64-apple-darwin", "bunny-hole-darwin-x86_64"],
  ["aarch64-apple-darwin", "bunny-hole-darwin-aarch64"],
  ["x86_64-pc-windows-msvc", "bunny-hole-windows-x86_64.exe"],
] as const;
const outputDirectory = "dist/release";
await Deno.mkdir(outputDirectory, { recursive: true });

for (const [target, filename] of targets) {
  await run("deno", [
    "compile",
    "--frozen",
    "--target",
    target,
    "--allow-env=BUNNY_HOLE_LOCAL_DEVELOPMENT,BUNNY_HOLE_ALLOW_PRIVATE_NETWORK,BUNNY_HOLE_RELAY_URL,BUNNY_HOLE_TUNNEL_ID,BUNNY_HOLE_TUNNEL_PRIVATE_KEY,BUNNY_HOLE_ORIGIN,BUNNY_HOLE_LOG_FORMAT",
    "--allow-net",
    "--allow-read",
    "--output",
    `${outputDirectory}/${filename}`,
    "apps/connector/main.ts",
  ]);
}

const checksums: string[] = [];
for (const [, filename] of targets) {
  const bytes = await Deno.readFile(`${outputDirectory}/${filename}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  checksums.push(`${checksum}  ${filename}`);
}
await Deno.writeTextFile(
  `${outputDirectory}/SHA256SUMS`,
  `${checksums.join("\n")}\n`,
);
console.log(
  `built Bunny Hole ${await readProductVersion()} for ${targets.length} targets`,
);

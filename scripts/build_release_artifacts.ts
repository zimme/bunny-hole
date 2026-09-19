import { basename, join } from "node:path";
import { run } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

interface Target {
  deno: string;
  key: string;
  frp: string;
  executable: string;
}

const targets: Target[] = [
  {
    deno: "x86_64-unknown-linux-gnu",
    key: "linux-amd64",
    frp: "linux_amd64",
    executable: "bunny-hole",
  },
  {
    deno: "aarch64-unknown-linux-gnu",
    key: "linux-arm64",
    frp: "linux_arm64",
    executable: "bunny-hole",
  },
  {
    deno: "x86_64-apple-darwin",
    key: "darwin-amd64",
    frp: "darwin_amd64",
    executable: "bunny-hole",
  },
  {
    deno: "aarch64-apple-darwin",
    key: "darwin-arm64",
    frp: "darwin_arm64",
    executable: "bunny-hole",
  },
  {
    deno: "x86_64-pc-windows-msvc",
    key: "windows-amd64",
    frp: "windows_amd64",
    executable: "bunny-hole.exe",
  },
  {
    deno: "aarch64-pc-windows-msvc",
    key: "windows-arm64",
    frp: "windows_arm64",
    executable: "bunny-hole.exe",
  },
];
const metadata = JSON.parse(await Deno.readTextFile("third_party/frp.json"));
const version = await readProductVersion();
const outputDirectory = "dist/release";
await Deno.mkdir(outputDirectory, { recursive: true });
const temporary = await Deno.makeTempDir({ prefix: "bunny-hole-release-" });

try {
  for (const target of targets) {
    const directory = join(temporary, `bunny-hole-${version}-${target.key}`);
    await Deno.mkdir(directory);
    await run("deno", [
      "compile",
      "--config",
      "deno.runtime.json",
      "--frozen",
      "--target",
      target.deno,
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-sys",
      "--output",
      join(directory, target.executable),
      "apps/connector/main.ts",
    ]);

    const extension = target.key.startsWith("windows") ? "zip" : "tar.gz";
    const archiveName = `frp_${metadata.version}_${target.frp}.${extension}`;
    const archive = join(temporary, archiveName);
    const response = await fetch(
      `https://github.com/fatedier/frp/releases/download/v${metadata.version}/${archiveName}`,
      { redirect: "follow", signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`FRP download failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (await sha256(bytes) !== metadata.archives[target.key]) {
      throw new Error(`FRP checksum mismatch for ${target.key}`);
    }
    await Deno.writeFile(archive, bytes);
    if (extension === "zip") {
      await run("unzip", ["-j", archive, "*/frpc.exe", "-d", directory]);
    } else {
      await run("tar", [
        "-xzf",
        archive,
        "-C",
        directory,
        "--strip-components=1",
        `frp_${metadata.version}_${target.frp}/frpc`,
      ]);
    }
    await Deno.writeTextFile(
      join(directory, "README.txt"),
      `Bunny Hole ${version}\n\nKeep bunny-hole and frpc in the same directory. Run bunny-hole --help.\n`,
    );
    await Deno.copyFile("third_party/frp.LICENSE", join(directory, "FRP-LICENSE.txt"));
    await run("tar", [
      "-czf",
      join(outputDirectory, `${basename(directory)}.tar.gz`),
      "-C",
      temporary,
      basename(directory),
    ]);
  }

  const artifacts: string[] = [];
  for await (const entry of Deno.readDir(outputDirectory)) {
    if (entry.isFile && entry.name.endsWith(".tar.gz")) artifacts.push(entry.name);
  }
  artifacts.sort();
  const checksums = [];
  for (const artifact of artifacts) {
    checksums.push(
      `${await sha256(
        await Deno.readFile(join(outputDirectory, artifact)),
      )}  ${artifact}`,
    );
  }
  await Deno.writeTextFile(
    join(outputDirectory, "SHA256SUMS"),
    `${checksums.join("\n")}\n`,
  );
  console.log(
    `built Bunny Hole ${version} connector bundles for ${targets.length} targets`,
  );
} finally {
  await Deno.remove(temporary, { recursive: true });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

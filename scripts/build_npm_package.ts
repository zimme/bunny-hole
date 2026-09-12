import { output, run } from "./process.ts";

interface NpmPackArtifact {
  filename: string;
  name: string;
  version: string;
}

/** Builds the npm tarball and returns its absolute path. */
export async function buildNpmPackage(
  outputDirectory: string,
  allowDirty = false,
): Promise<string> {
  await Deno.mkdir(outputDirectory, { recursive: true });
  const absoluteOutputDirectory = await Deno.realPath(outputDirectory);
  const temporaryDirectory = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "bunny-hole-npm-",
  });
  try {
    const denoTarball = `${temporaryDirectory}/deno-package.tgz`;
    const extracted = `${temporaryDirectory}/extracted`;
    await Deno.mkdir(extracted);
    const packArgs = [
      "pack",
      "--output",
      denoTarball,
    ];
    if (allowDirty) packArgs.splice(1, 0, "--allow-dirty");
    await run("deno", packArgs);
    await run("tar", ["-xzf", denoTarball, "-C", extracted]);

    const manifestPath = `${extracted}/package/package.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    Object.assign(manifest, {
      description: "Embed the Bunny Hole reverse-tunnel connector.",
      author: "zimme",
      homepage: "https://github.com/zimme/bunny-hole#readme",
      repository: {
        type: "git",
        url: "git+https://github.com/zimme/bunny-hole.git",
      },
      bugs: { url: "https://github.com/zimme/bunny-hole/issues" },
      keywords: [
        "bunny.net",
        "reverse-tunnel",
        "http-tunnel",
        "connector",
        "deno",
      ],
      engines: { node: ">=22.14.0" },
      publishConfig: { access: "public" },
      sideEffects: false,
    });
    await Deno.writeTextFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const packed = await output("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      absoluteOutputDirectory,
    ], {
      cwd: `${extracted}/package`,
      env: {
        NPM_CONFIG_CACHE: `${temporaryDirectory}/npm-cache`,
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
      },
    });
    const artifact = parseNpmPackOutput(packed);
    if (artifact.name !== "@zimme/bunny-hole") {
      throw new Error(`unexpected npm package name: ${artifact.name}`);
    }
    return `${absoluteOutputDirectory}/${artifact.filename}`;
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
}

function parseNpmPackOutput(value: string): NpmPackArtifact {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack did not return exactly one artifact");
  }
  const artifact = parsed[0] as Partial<NpmPackArtifact>;
  if (
    typeof artifact.filename !== "string" ||
    artifact.filename.includes("/") ||
    artifact.filename.includes("\\") ||
    typeof artifact.name !== "string" ||
    typeof artifact.version !== "string"
  ) throw new Error("npm pack returned an invalid artifact");
  return artifact as NpmPackArtifact;
}

if (import.meta.main) {
  const path = await buildNpmPackage(
    Deno.args.find((value) => !value.startsWith("--")) ?? "dist/npm",
    Deno.args.includes("--allow-dirty"),
  );
  console.log(`npm package: ${path}`);
}

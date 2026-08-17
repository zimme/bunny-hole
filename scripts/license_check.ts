const license = await Deno.readTextFile("LICENSE");
if (!license.includes("MIT License") || !license.includes("2026")) {
  throw new Error("LICENSE is not the expected MIT license");
}
const config = JSON.parse(await Deno.readTextFile("deno.json"));
const imports = Object.values(config.imports ?? {}) as string[];
if (
  imports.length !== 1 || imports[0] !== "npm:cspell@9.2.1"
) {
  throw new Error("runtime dependency added without license review");
}
for (
  const manifest of [
    "apps/edge-relay/deno.json",
    "apps/relay/deno.json",
    "fixtures/origin/deno.json",
  ]
) {
  const workspaceConfig = JSON.parse(await Deno.readTextFile(manifest));
  if (workspaceConfig.imports !== undefined) {
    throw new Error(`${manifest} added dependencies without license review`);
  }
}

const externalImports: string[] = [];
for (const root of ["apps", "fixtures", "packages"]) {
  for (const file of await typeScriptFiles(root)) {
    const source = await Deno.readTextFile(file);
    for (
      const match of source.matchAll(
        /\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g,
      )
    ) {
      if (!match[1].startsWith(".")) externalImports.push(`${file}: ${match[1]}`);
    }
  }
}
if (
  externalImports.join("\n") !==
    "apps/edge-relay/main.ts: @bunny.net/edgescript-sdk"
) {
  throw new Error(
    `source dependency set changed without license review:\n${
      externalImports.join("\n")
    }`,
  );
}
console.log(
  "license check: MIT project; cspell is tooling and the Bunny SDK is runtime-provided",
);

async function typeScriptFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory) files.push(...await typeScriptFiles(child));
    else if (entry.isFile && entry.name.endsWith(".ts")) files.push(child);
  }
  return files.sort();
}

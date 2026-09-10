const license = await Deno.readTextFile("LICENSE");
if (!license.includes("MIT License") || !license.includes("2026")) {
  throw new Error("LICENSE is not the expected MIT license");
}
const config = JSON.parse(await Deno.readTextFile("deno.json"));
const imports = Object.values(config.imports ?? {}) as string[];
if (
  imports.sort().join("\n") !==
    ["npm:@simplewebauthn/server@13.3.2", "npm:cspell@10.3.0"].sort().join(
      "\n",
    )
) {
  throw new Error("runtime dependency added without license review");
}
const runtimeConfig = JSON.parse(await Deno.readTextFile("deno.runtime.json"));
if (
  Object.values(runtimeConfig.imports ?? {}).join("\n") !==
    "npm:@simplewebauthn/server@13.3.2"
) {
  throw new Error("production dependency graph changed without license review");
}
for (const manifest of ["fixtures/origin/deno.json"]) {
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
      if (!match[1].startsWith(".") && !match[1].startsWith("node:")) {
        externalImports.push(`${file}: ${match[1]}`);
      }
    }
  }
}
if (
  externalImports.join("\n") !==
    "apps/host/passkeys.ts: @simplewebauthn/server"
) {
  throw new Error(
    `source dependency set changed without license review:\n${
      externalImports.join("\n")
    }`,
  );
}
const frp = JSON.parse(await Deno.readTextFile("third_party/frp.json"));
if (frp.version !== "0.70.1" || frp.license !== "Apache-2.0") {
  throw new Error("embedded FRP version or license was not reviewed");
}
console.log(
  "license check: MIT project; SimpleWebAuthn is MIT; cspell is tooling; embedded FRP is Apache-2.0",
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

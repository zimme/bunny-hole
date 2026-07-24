const license = await Deno.readTextFile("LICENSE");
if (!license.includes("MIT License") || !license.includes("2026")) {
  throw new Error("LICENSE is not the expected MIT license");
}
const config = JSON.parse(await Deno.readTextFile("deno.json"));
const imports = Object.values(config.imports ?? {}) as string[];
if (imports.some((entry) => !entry.startsWith("npm:cspell@"))) {
  throw new Error("runtime dependency added without license review");
}
console.log("license check: MIT project; no third-party runtime dependencies");

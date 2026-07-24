import { run } from "./process.ts";

await run("deno", [
  "doc",
  "--json",
  "packages/protocol/mod.ts",
  "packages/protocol/auth.ts",
  "packages/protocol/security.ts",
], { stdout: "null" });

const markdown = await collect(".");
const missing: string[] = [];
for (const file of markdown) {
  const text = await Deno.readTextFile(file);
  for (
    const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/g)
  ) {
    const target = new URL(match[1], new URL(`file://${Deno.cwd()}/${file}`)).pathname;
    try {
      await Deno.stat(target);
    } catch {
      missing.push(`${file}: ${match[1]}`);
    }
  }
}
if (missing.length) {
  throw new Error(`broken documentation links:\n${missing.join("\n")}`);
}
console.log(`documentation check: ${markdown.length} Markdown files and protocol API`);

async function collect(path: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if ([".git", "node_modules", "coverage", "dist"].includes(entry.name)) continue;
    const child = path === "." ? entry.name : `${path}/${entry.name}`;
    if (entry.isDirectory) files.push(...await collect(child));
    else if (entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

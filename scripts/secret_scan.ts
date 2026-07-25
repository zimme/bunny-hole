import { output } from "./process.ts";

async function walk(path = "."): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const child = path === "." ? entry.name : `${path}/${entry.name}`;
    if (
      entry.isDirectory &&
      [".git", "coverage", "dist", "node_modules"].includes(entry.name)
    ) continue;
    if (entry.isDirectory) files.push(...await walk(child));
    else if (entry.isFile) files.push(child);
  }
  return files;
}

let files: string[];
try {
  files =
    (await output("git", ["ls-files", "--cached", "--others", "--exclude-standard"]))
      .split("\n").filter(Boolean);
} catch {
  console.warn("secret scan: Git metadata unavailable; scanning the workspace");
  files = await walk();
}
const findings: string[] = [];
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBUNNYNET_API_KEY\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/,
];
for (const file of files) {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  if (patterns.some((pattern) => pattern.test(text))) findings.push(file);
}
if (findings.length) throw new Error(`possible secrets in: ${findings.join(", ")}`);
console.log(`secret scan: ${files.length} files checked`);

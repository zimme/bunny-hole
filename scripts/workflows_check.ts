import { parseDocument } from "npm:yaml@2.9.0";

const failures: string[] = [];
for await (const entry of Deno.readDir(".github/workflows")) {
  if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
  const path = `.github/workflows/${entry.name}`;
  const document = parseDocument(await Deno.readTextFile(path), {
    uniqueKeys: true,
  });
  for (const error of document.errors) failures.push(`${path}: ${error.message}`);
  inspect(document.toJS(), path);
}
if (failures.length > 0) throw new Error(failures.join("\n"));
console.log("workflow check: valid YAML and immutable action references");

function inspect(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const item of value) inspect(item, path);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "uses" && typeof child === "string" && !child.startsWith("./") &&
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(
        child,
      ) &&
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(child)
    ) failures.push(`${path}: action reference is not commit-pinned: ${child}`);
    inspect(child, path);
  }
}

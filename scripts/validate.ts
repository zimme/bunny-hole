import { run } from "./process.ts";

const steps: [string, string[]][] = [
  ["deno", ["task", "agents:check"]],
  ["deno", ["task", "version:check"]],
  ["deno", ["ci"]],
  ["deno", ["task", "fmt:check"]],
  ["deno", ["task", "spellcheck"]],
  ["deno", ["task", "lint"]],
  ["deno", ["task", "check"]],
  ["deno", ["task", "docs:check"]],
  ["deno", ["task", "commits:check"]],
  ["deno", ["task", "test"]],
  ["deno", ["task", "coverage"]],
  ["deno", ["task", "integration"]],
  ["deno", ["task", "build"]],
  ["deno", ["task", "container:smoke"]],
  ["deno", ["task", "audit"]],
  ["deno", ["task", "secrets:check"]],
  ["deno", ["task", "licenses:check"]],
  ["deno", ["task", "generated:check"]],
];

for (const [command, args] of steps) {
  console.log(`\n==> ${command} ${args.join(" ")}`);
  await run(command, args);
}

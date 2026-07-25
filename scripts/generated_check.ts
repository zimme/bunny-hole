import { output, run } from "./process.ts";

const metadata = await new Deno.Command("git", {
  args: ["rev-parse", "--is-inside-work-tree"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!metadata.success) {
  console.warn(
    "generated-file check: Git metadata unavailable; tracked-file checks skipped",
  );
  Deno.exit(0);
}
await run("git", ["diff", "--check"]);
await run("git", ["diff", "--cached", "--check"]);
const tracked = await output("git", ["ls-files"]);
for (const forbidden of ["coverage/", "dist/", ".env", "CHANGELOG.md"]) {
  if (
    tracked.split("\n").some((file) => file === forbidden || file.startsWith(forbidden))
  ) {
    throw new Error(`generated or forbidden artifact is tracked: ${forbidden}`);
  }
}
console.log("generated-file check: clean");

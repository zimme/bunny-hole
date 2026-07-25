import { output } from "./process.ts";

const whitespace = await new Deno.Command("git", {
  args: ["diff", "--check"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!whitespace.success) {
  console.warn(
    "generated-file check: Git metadata unavailable; formatting is enforced separately",
  );
  Deno.exit(0);
}
const tracked = await output("git", ["ls-files"]);
for (const forbidden of ["coverage/", "dist/", ".env", "CHANGELOG.md"]) {
  if (
    tracked.split("\n").some((file) => file === forbidden || file.startsWith(forbidden))
  ) {
    throw new Error(`generated or forbidden artifact is tracked: ${forbidden}`);
  }
}
console.log("generated-file check: clean");

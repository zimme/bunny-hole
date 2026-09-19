import { output, run } from "./process.ts";

if (import.meta.main) {
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
  for (const file of tracked.split("\n")) {
    if (isForbiddenTrackedArtifact(file)) {
      throw new Error(`generated or forbidden artifact is tracked: ${file}`);
    }
  }
  console.log("generated-file check: clean");
}

export function isForbiddenTrackedArtifact(file: string): boolean {
  const segments = file.split("/");
  const name = segments.at(-1) ?? "";
  return segments.includes("coverage") || segments.includes("dist") ||
    name === "CHANGELOG.md" || name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example");
}

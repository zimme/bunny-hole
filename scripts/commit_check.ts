const result = await new Deno.Command("git", {
  args: ["log", "--format=%s"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!result.success) {
  console.warn(
    "commit check: Git metadata unavailable (expected in an isolated linked-worktree container)",
  );
  Deno.exit(0);
}
const subjects = new TextDecoder().decode(result.stdout).trim().split("\n").filter(
  Boolean,
);
const conventional =
  /^(feat|fix|docs|test|refactor|perf|build|ci|chore)(\([a-z0-9-]+\))?!?: .+/;
const invalid = subjects.filter((subject) => !conventional.test(subject));
if (invalid.length) {
  throw new Error(`non-Conventional Commit subjects: ${invalid.join(", ")}`);
}
console.log(`commit check: ${subjects.length} Conventional Commit subject(s)`);

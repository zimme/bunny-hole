const command = new Deno.Command("git", {
  args: ["config", "core.hooksPath", ".githooks"],
  stdout: "piped",
  stderr: "piped",
});
const result = await command.output();
if (!result.success) {
  const detail = new TextDecoder().decode(result.stderr).trim();
  console.warn(`hook installation skipped: ${detail || "git config failed"}`);
} else {
  console.log("configured tracked Conventional Commit hooks");
}

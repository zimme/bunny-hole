const canonical = await Deno.readTextFile("AGENTS.md");
if (!canonical.includes("deno task validate") || !canonical.includes("Bunny Hole")) {
  throw new Error("AGENTS.md is missing canonical project instructions");
}
const geminiSettings = JSON.parse(
  await Deno.readTextFile(".gemini/settings.json"),
) as { context?: { fileName?: unknown } };
if (
  !Array.isArray(geminiSettings.context?.fileName) ||
  !geminiSettings.context.fileName.includes("AGENTS.md")
) {
  throw new Error(
    ".gemini/settings.json must configure context.fileName to include AGENTS.md",
  );
}
const skillDirs = [...Deno.readDirSync(".agents/skills")].filter((entry) =>
  entry.isDirectory
);
if (skillDirs.length === 0) {
  throw new Error(".agents/skills must contain at least one skill directory");
}
for (const dir of skillDirs) {
  await Deno.stat(`.agents/skills/${dir.name}/SKILL.md`);
}

const devcontainer = JSON.parse(
  await Deno.readTextFile(".devcontainer/devcontainer.json"),
) as {
  service?: unknown;
  runServices?: unknown;
  updateRemoteUserUID?: unknown;
};
if (
  devcontainer.service !== "development" ||
  !Array.isArray(devcontainer.runServices) ||
  devcontainer.runServices.length !== 1 ||
  devcontainer.runServices[0] !== "development" ||
  devcontainer.updateRemoteUserUID !== false
) {
  throw new Error(
    "Dev Container tools must preserve the Compose development service and UID",
  );
}

const canonical = await Deno.readTextFile("AGENTS.md");
if (!canonical.includes("deno task validate") || !canonical.includes("Bunny Hole")) {
  throw new Error("AGENTS.md is missing canonical project instructions");
}
const gemini = JSON.parse(await Deno.readTextFile(".gemini/settings.json"));
if (JSON.stringify(gemini.context?.fileName) !== '["AGENTS.md"]') {
  throw new Error("Gemini CLI must load the canonical AGENTS.md");
}
const directories: string[] = [];
for await (const entry of Deno.readDir(".agents/skills")) {
  if (!entry.isDirectory) continue;
  const path = `.agents/skills/${entry.name}/SKILL.md`;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) continue;
    throw error;
  }
  directories.push(entry.name);
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (
    !frontmatter ||
    frontmatter[1].match(/^name: (.+)$/m)?.[1] !== entry.name ||
    !/^description: \S.+$/m.test(frontmatter[1])
  ) throw new Error(`${path} needs matching name and nonempty description`);
}
if (directories.length === 0) throw new Error("No agent skills found");
const devcontainer = JSON.parse(
  await Deno.readTextFile(".devcontainer/devcontainer.json"),
) as {
  service?: unknown;
  runServices?: unknown;
  updateRemoteUserUID?: unknown;
  initializeCommand?: unknown;
};
if (
  devcontainer.service !== "development" ||
  !Array.isArray(devcontainer.runServices) ||
  devcontainer.runServices.length !== 1 ||
  devcontainer.runServices[0] !== "development" ||
  devcontainer.updateRemoteUserUID !== false ||
  !Array.isArray(devcontainer.initializeCommand) ||
  devcontainer.initializeCommand.join(" ") !==
    "sh .devcontainer/initialize.sh"
) {
  throw new Error(
    "Dev Container tools must preserve the Compose service, initializer, and UID",
  );
}

const canonical = await Deno.readTextFile("AGENTS.md");
if (!canonical.includes("deno task validate") || !canonical.includes("Bunny Hole")) {
  throw new Error("AGENTS.md is missing canonical project instructions");
}
for (const shim of ["CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
  const text = await Deno.readTextFile(shim);
  if (!text.includes("AGENTS.md")) throw new Error(`${shim} must point to AGENTS.md`);
}
const skills = await Deno.readTextFile("SKILLS.md");
if (!skills.includes(".agents/skills/")) throw new Error("SKILLS.md is incomplete");

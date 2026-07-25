import {
  assertComVerBump,
  compareComVer,
  hasBreakingChange,
  parseComVer,
} from "./comver.ts";
import { output } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

const tag = Deno.args[0] ?? "";
const current = parseComVer(tag);
const productVersion = await readProductVersion();
if (tag !== productVersion) {
  throw new Error(
    `release tag ${tag} does not match product version ${productVersion}`,
  );
}

const tags = (await output("git", ["tag", "--list"])).split("\n")
  .filter((candidate) => candidate && candidate !== tag)
  .flatMap((candidate) => {
    try {
      return [parseComVer(candidate)];
    } catch {
      return [];
    }
  })
  .sort(compareComVer);
const previous = tags.at(-1);

if (previous) {
  const commits = await output("git", [
    "log",
    `${previous.value}..HEAD`,
    "--format=%s%n%b",
  ]);
  const breaking = hasBreakingChange(commits);
  assertComVerBump(previous, current, breaking);
  console.log(
    `release check: ${previous.value} -> ${tag} (${
      breaking ? "breaking" : "non-breaking"
    })`,
  );
} else {
  console.log(`release check: ${tag} is the first ComVer release`);
}

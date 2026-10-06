import {
  assertReleaseHistory,
  compareReleaseVersion,
  hasBreakingChange,
  parseReleaseVersion,
} from "./comver.ts";
import { output } from "./process.ts";
import { readProductVersion } from "./version_check.ts";

const tag = Deno.args[0] ?? "";
const current = parseReleaseVersion(tag);
const productVersion = await readProductVersion();
if (tag !== productVersion) {
  throw new Error(
    `release tag ${tag} does not match product version ${productVersion}`,
  );
}

const tags = (await output("git", ["tag", "--list"]))
  .split("\n")
  .filter((candidate) => candidate && candidate !== tag)
  .flatMap((candidate) => {
    try {
      return [parseReleaseVersion(candidate)];
    } catch {
      return [];
    }
  })
  .sort(compareReleaseVersion);
const latest = tags.at(-1);
if (latest && compareReleaseVersion(current, latest) <= 0) {
  throw new Error("release version must increase across all release tags");
}
const previous = tags.filter((version) => version.candidate === null).at(-1);

if (previous) {
  try {
    await output("git", ["merge-base", "--is-ancestor", previous.value, "HEAD"]);
  } catch (cause) {
    throw new Error("latest stable release must be an ancestor of HEAD", { cause });
  }
  const commits = await output("git", [
    "log",
    `${previous.value}..HEAD`,
    "--format=%s%n%b",
  ]);
  const breaking = hasBreakingChange(commits);
  assertReleaseHistory(current, tags, breaking);
  console.log(
    `release check: ${previous.value} -> ${tag} (${
      breaking ? "breaking" : "non-breaking"
    })`,
  );
} else {
  assertReleaseHistory(current, tags, false);
  console.log(`release check: ${tag} is the first ComVer release`);
}

export interface ComVer {
  major: bigint;
  minor: bigint;
  patch: 0;
  value: string;
}

export function parseComVer(value: string): ComVer {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/);
  if (!match) {
    throw new Error(`invalid ComVer ${value}; expected MAJOR.MINOR.0`);
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: 0,
    value,
  };
}

export function compareComVer(left: ComVer, right: ComVer): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  return 0;
}

export function assertComVerBump(
  previous: ComVer,
  current: ComVer,
  breaking: boolean,
): void {
  if (compareComVer(current, previous) <= 0) {
    throw new Error("release version must increase");
  }
  if (breaking) {
    if (current.major !== previous.major + 1n || current.minor !== 0n) {
      throw new Error("breaking changes require the next major ComVer line");
    }
    return;
  }
  if (
    current.major !== previous.major ||
    current.minor !== previous.minor + 1n
  ) {
    throw new Error("non-breaking changes require a minor ComVer bump");
  }
}

export function hasBreakingChange(commitLog: string): boolean {
  return /^(?:[a-z]+(?:\([^)]+\))?!:|BREAKING(?: |-)CHANGE:)/m.test(commitLog);
}

export interface ReleaseVersion {
  base: ComVer;
  candidate: bigint | null;
  value: string;
}

/** Stable releases or the deliberately narrow, explicit rc.N evaluation channel. */
export function parseReleaseVersion(value: string): ReleaseVersion {
  const match = /^(.*?)(?:-rc\.([1-9]\d*))?$/.exec(value);
  if (!match) throw new Error("release must use MAJOR.MINOR.0 or MAJOR.MINOR.0-rc.N");
  return {
    base: parseComVer(match[1]),
    candidate: match[2] ? BigInt(match[2]) : null,
    value,
  };
}

export function compareReleaseVersion(a: ReleaseVersion, b: ReleaseVersion): number {
  const base = compareComVer(a.base, b.base);
  if (base) return base;
  if (a.candidate === b.candidate) return 0;
  if (a.candidate === null) return 1;
  if (b.candidate === null) return -1;
  return a.candidate < b.candidate ? -1 : 1;
}

export function assertReleaseHistory(
  current: ReleaseVersion,
  history: ReleaseVersion[],
  breaking: boolean,
): void {
  const ordered = [...history].sort(compareReleaseVersion);
  const latest = ordered.at(-1);
  if (latest && compareReleaseVersion(current, latest) <= 0) {
    throw new Error("release version must increase, including candidate sequence");
  }
  const stable = ordered.filter((version) => version.candidate === null).at(-1);
  if (stable) assertComVerBump(stable.base, current.base, breaking);
  if (current.candidate !== null) {
    const preceding = ordered.filter((version) =>
      compareComVer(version.base, current.base) === 0 && version.candidate !== null
    ).at(-1);
    if (current.candidate !== (preceding?.candidate ?? 0n) + 1n) {
      throw new Error("candidate sequence must start at rc.1 and increase by one");
    }
  }
}

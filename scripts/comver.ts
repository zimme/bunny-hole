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

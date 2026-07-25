export interface ComVer {
  major: number;
  minor: number;
  patch: 0;
  value: string;
}

export function parseComVer(value: string): ComVer {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/);
  if (!match) {
    throw new Error(`invalid ComVer ${value}; expected MAJOR.MINOR.0`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: 0,
    value,
  };
}

export function compareComVer(left: ComVer, right: ComVer): number {
  return left.major - right.major || left.minor - right.minor;
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
    if (current.major !== previous.major + 1 || current.minor !== 0) {
      throw new Error("breaking changes require the next major ComVer line");
    }
    return;
  }
  if (
    current.major !== previous.major ||
    current.minor !== previous.minor + 1
  ) {
    throw new Error("non-breaking changes require a minor ComVer bump");
  }
}

export function hasBreakingChange(commitLog: string): boolean {
  return /^(?:[a-z]+(?:\([^)]+\))?!:|BREAKING(?: |-)CHANGE:)/m.test(commitLog);
}

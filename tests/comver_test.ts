import {
  assertComVerBump,
  assertReleaseHistory,
  compareComVer,
  compareReleaseVersion,
  hasBreakingChange,
  parseComVer,
  parseReleaseVersion,
} from "../scripts/comver.ts";
import { assertEquals, assertThrows } from "./assert.ts";

Deno.test("Bunny Hole release candidates extend ComVer without changing stable policy", () => {
  const parse = parseReleaseVersion;
  assertEquals(parse("1.0.0-rc.1").candidate, 1n);
  assertEquals(compareReleaseVersion(parse("1.0.0-rc.9"), parse("1.0.0-rc.10")), -1);
  assertEquals(compareReleaseVersion(parse("1.0.0-rc.10"), parse("1.0.0")), -1);
  for (
    const invalid of [
      "1.0.1-rc.1",
      "1.0.0-RC.1",
      "1.0.0-rc.0",
      "1.0.0-rc.01",
      "1.0.0-beta.1",
      "1.0.0-rc.1+build",
    ]
  ) {
    assertThrows(() => parse(invalid));
  }
  assertReleaseHistory(parse("1.0.0-rc.1"), [], false);
  assertReleaseHistory(parse("1.0.0-rc.2"), [parse("1.0.0-rc.1")], false);
  assertReleaseHistory(parse("1.0.0"), [parse("1.0.0-rc.2")], false);
  assertReleaseHistory(parse("1.1.0-rc.1"), [parse("1.0.0")], false);
  assertReleaseHistory(parse("2.0.0-rc.1"), [parse("1.0.0")], true);
  assertReleaseHistory(parse("1.1.0"), [parse("1.0.0"), parse("1.1.0-rc.1")], false);
  for (
    const [version, previous, breaking] of [
      ["1.0.0-rc.2", [], false],
      ["1.0.0-rc.3", ["1.0.0-rc.1"], false],
      ["1.0.0-rc.1", ["1.0.0-rc.1"], false],
      ["1.0.0-rc.2", ["1.0.0"], false],
      ["1.1.0-rc.1", ["1.0.0"], true],
      ["2.0.0-rc.1", ["1.0.0"], false],
      ["1.0.0", ["1.1.0-rc.1"], false],
    ] as const
  ) {
    assertThrows(() =>
      assertReleaseHistory(parse(version), previous.map(parse), breaking)
    );
  }
});

Deno.test("ComVer requires a zero patch component and canonical numbers", () => {
  assertEquals(parseComVer("2.7.0"), {
    major: 2n,
    minor: 7n,
    patch: 0,
    value: "2.7.0",
  });
  assertEquals(parseComVer("0.7.0").major, 0n);
  for (
    const invalid of [
      "1.2.3",
      "1.2",
      "01.2.0",
      "1.02.0",
      "1.2.0-beta",
      "1.2.0+build",
    ]
  ) {
    assertThrows(() => parseComVer(invalid));
  }
});

Deno.test("ComVer compares unbounded numeric identifiers exactly", () => {
  const previous = parseComVer("90071992547409931234567890.8.0");
  const current = parseComVer("90071992547409931234567890.9.0");
  assertEquals(compareComVer(previous, current), -1);
  assertComVerBump(previous, current, false);
});

Deno.test("major zero follows the same compatibility rules", () => {
  assertComVerBump(parseComVer("0.4.0"), parseComVer("0.5.0"), false);
  assertComVerBump(parseComVer("0.4.0"), parseComVer("1.0.0"), true);
  assertThrows(() =>
    assertComVerBump(parseComVer("0.4.0"), parseComVer("0.5.0"), true)
  );
});

Deno.test("non-breaking changes, including fixes, require a minor bump", () => {
  assertComVerBump(parseComVer("1.4.0"), parseComVer("1.5.0"), false);
  assertThrows(() =>
    assertComVerBump(parseComVer("1.4.0"), parseComVer("2.0.0"), false)
  );
  assertThrows(() =>
    assertComVerBump(parseComVer("1.4.0"), parseComVer("1.4.0"), false)
  );
  assertThrows(() =>
    assertComVerBump(parseComVer("1.4.0"), parseComVer("1.6.0"), false)
  );
});

Deno.test("every breaking change, including a breaking fix, requires a major bump", () => {
  assertComVerBump(parseComVer("1.9.0"), parseComVer("2.0.0"), true);
  assertThrows(() =>
    assertComVerBump(parseComVer("1.9.0"), parseComVer("1.10.0"), true)
  );
  assertThrows(() =>
    assertComVerBump(parseComVer("1.9.0"), parseComVer("2.1.0"), true)
  );
  assertThrows(() =>
    assertComVerBump(parseComVer("1.9.0"), parseComVer("3.0.0"), true)
  );
  assertEquals(
    compareComVer(parseComVer("2.0.0"), parseComVer("1.99.0")) > 0,
    true,
  );
});

Deno.test("Conventional Commit markers classify breaking bug fixes", () => {
  assertEquals(hasBreakingChange("fix!: change an incompatible default"), true);
  assertEquals(
    hasBreakingChange("fix(config)!: reject the legacy form"),
    true,
  );
  assertEquals(
    hasBreakingChange("fix: correct parsing\n\nBREAKING CHANGE: old inputs fail"),
    true,
  );
  assertEquals(hasBreakingChange("fix: preserve compatibility"), false);
});

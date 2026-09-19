import {
  assertComVerBump,
  compareComVer,
  hasBreakingChange,
  parseComVer,
} from "../scripts/comver.ts";
import { assertEquals, assertThrows } from "./assert.ts";

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

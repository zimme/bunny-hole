import { evaluateCoverage } from "../scripts/coverage_check.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";
const source = "apps/test.ts";
const record =
  `SF:/repo/${source}\nLF:100\nLH:100\nFNF:10\nFNH:10\nBRF:20\nBRH:20\nend_of_record\n`;
Deno.test("coverage gate rejects missing files, regressions and incomplete or dishonest metrics", () => {
  assertEquals(evaluateCoverage(record, [source], "/repo").failures, []);
  assertEquals(
    evaluateCoverage(record, [source, "apps/missing.ts"], "/repo").failures,
    ["missing application coverage: apps/missing.ts"],
  );
  for (
    const [field, value, metric] of [["LH", "94", "lines"], ["FNH", "9", "functions"], [
      "BRH",
      "17",
      "branches",
    ]]
  ) {
    assert(
      evaluateCoverage(
        record.replace(
          `${field}:${field === "LH" ? 100 : field === "FNH" ? 10 : 20}`,
          `${field}:${value}`,
        ),
        [source],
        "/repo",
      ).failures.some((failure) => failure.includes(metric)),
    );
  }
  assertThrows(() => evaluateCoverage(record + record, [source], "/repo"), /duplicate/);
  assertThrows(
    () => evaluateCoverage(record.replace("LF:100\n", ""), [source], "/repo"),
    /metric/,
  );
  assertThrows(
    () => evaluateCoverage(record.replace("LH:100", "LH:101"), [source], "/repo"),
    /hit count/,
  );
  assertThrows(
    () =>
      evaluateCoverage(
        record.replace("LF:100", "LF:99999999999999999999"),
        [source],
        "/repo",
      ),
    /count/,
  );
});
Deno.test("coverage gate counts only inventoried application files and handles empty modules", () => {
  const zero = record.replace(/:(100|10|20)\n/g, ":0\n");
  assertEquals(evaluateCoverage(zero, [source], "/repo").failures, []);
  assertEquals(
    evaluateCoverage(record.replace("/repo/", "file:///repo/"), [source], "/repo")
      .failures,
    [],
  );
  assertEquals(
    evaluateCoverage(record + record.replace("apps/test.ts", "tests/helper.ts"), [
      source,
    ], "/repo").totals.lines.found,
    100,
  );
});

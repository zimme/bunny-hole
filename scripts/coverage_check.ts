import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.ts";

type Metric = "lines" | "branches" | "functions";
type Counts = Record<Metric, { found: number; hit: number }>;
// Every application file is counted. Lower floors retain visible platform and
// exceptional-I/O gaps; they are not coverage exclusions.
const lineFloors: Record<string, number> = {
  "apps/compose/main.ts": 100,
  "apps/compose/model.ts": 100,
  "apps/connector/agent_skill.ts": 100,
  "apps/connector/client.ts": 100,
  "apps/connector/frpc.ts": 96,
  "apps/connector/frpc_config.ts": 96,
  "apps/connector/supervisor.ts": 98,
  "apps/connector/origin_bridge.ts": 90,
  "apps/connector/state.ts": 78,
  "apps/host/config.ts": 100,
  "apps/host/frp.ts": 93,
  "apps/host/main.ts": 99,
  "apps/host/passkeys.ts": 97,
  "apps/host/session.ts": 96,
  "apps/host/identity.ts": 100,
  "apps/host/store.ts": 93,
  "apps/operator/main.ts": 96,
  "packages/api/auth.ts": 94,
  "packages/api/logger.ts": 100,
  "packages/api/mod.ts": 100,
  "packages/api/security.ts": 100,
};
export const applicationThresholds = { lines: 95, branches: 90, functions: 97 };

export function evaluateCoverage(
  report: string,
  expectedFiles: string[],
  root: string,
  thresholds = applicationThresholds,
  floors = lineFloors,
): { totals: Counts; failures: string[] } {
  const totals: Counts = {
    lines: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
  };
  const records = new Map<string, Counts>();
  for (const record of report.split("end_of_record")) {
    const source = record.match(/^SF:(.+)$/m)?.[1];
    if (!source) continue;
    const path = relative(
      root,
      source.startsWith("file:") ? fileURLToPath(source) : source,
    ).replaceAll("\\", "/");
    if (!expectedFiles.includes(path)) continue;
    if (records.has(path)) throw new Error(`duplicate coverage record: ${path}`);
    const read = (key: string) => {
      const matches = [...record.matchAll(new RegExp(`^${key}:(\\d+)$`, "gm"))];
      if (matches.length !== 1) {
        throw new Error(`invalid coverage metric ${key}: ${path}`);
      }
      const value = Number(matches[0][1]);
      if (!Number.isSafeInteger(value)) {
        throw new Error(`invalid coverage count: ${path}`);
      }
      return value;
    };
    const counts: Counts = {
      lines: { found: read("LF"), hit: read("LH") },
      branches: { found: read("BRF"), hit: read("BRH") },
      functions: { found: read("FNF"), hit: read("FNH") },
    };
    for (const metric of Object.keys(totals) as Metric[]) {
      if (counts[metric].hit > counts[metric].found) {
        throw new Error(`invalid coverage hit count: ${path}`);
      }
      totals[metric].found += counts[metric].found;
      totals[metric].hit += counts[metric].hit;
    }
    records.set(path, counts);
  }
  const failures: string[] = [];
  for (const file of expectedFiles) {
    const counts = records.get(file);
    if (!counts) {
      failures.push(`missing application coverage: ${file}`);
      continue;
    }
    const floor = floors[file] ?? 95;
    if (percentage(counts.lines) < floor) {
      failures.push(
        `${file}: line coverage ${percentage(counts.lines).toFixed(2)}% < ${floor}%`,
      );
    }
  }
  for (const metric of Object.keys(totals) as Metric[]) {
    if (percentage(totals[metric]) < thresholds[metric]) {
      failures.push(
        `application ${metric}: ${percentage(totals[metric]).toFixed(2)}% < ${
          thresholds[metric]
        }%`,
      );
    }
  }
  return { totals, failures };
}
function percentage(counts: { found: number; hit: number }): number {
  return counts.found === 0 ? 100 : 100 * counts.hit / counts.found;
}
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...await sourceFiles(path));
    else if (entry.isFile && path.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}
if (import.meta.main) {
  // Preserve the original whole-suite gate, now raised from 70 to 90 percent.
  await run("deno", ["coverage", "coverage", "--threshold=90"]);
  const result = await new Deno.Command("deno", {
    args: ["coverage", "coverage", "--lcov", "--include=/(apps|packages)/"],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("application coverage collection failed");
  const report = new TextDecoder().decode(result.stdout);
  await Deno.writeTextFile("coverage/application.lcov", report);
  const files = [...await sourceFiles("apps"), ...await sourceFiles("packages")];
  const evaluated = evaluateCoverage(report, files, resolve("."));
  for (const [metric, counts] of Object.entries(evaluated.totals)) {
    console.log(
      `application ${metric}: ${
        percentage(counts).toFixed(2)
      }% (${counts.hit}/${counts.found})`,
    );
  }
  if (evaluated.failures.length) throw new Error(evaluated.failures.join("\n"));
  console.log(
    `application coverage: ${files.length} source files accounted for; no exclusions`,
  );
}

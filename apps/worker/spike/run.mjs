// Orchestrator for the worker-runtime spike (issue #02 / ADR-0001).
// Runs spike.mjs under Bun and under Node sequentially, parses each summary,
// writes results.json, and prints a side-by-side comparison.
//
//   bun run apps/worker/spike/run.mjs
//
// Env: SPIKE_ITERATIONS (default 50).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harness = join(__dirname, "spike.mjs");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("__SPIKE_RESULT__"));
      if (!line) {
        return reject(
          new Error(`${cmd} produced no __SPIKE_RESULT__ (exit ${code})`),
        );
      }
      resolve(JSON.parse(line.replace("__SPIKE_RESULT__", "")));
    });
  });
}

console.error("=== Running spike under Node ===");
const node = await run("node", [harness]);
console.error("=== Running spike under Bun ===");
const bun = await run("bun", ["run", harness]);

const results = { bun, node };
writeFileSync(join(__dirname, "results.json"), JSON.stringify(results, null, 2));

const rows = [
  ["metric", "bun", "node"],
  ["runtime version", bun.runtime.version, node.runtime.version],
  ["iterations", bun.iterations, node.iterations],
  ["success", bun.successCount, node.successCount],
  ["failures", bun.failureCount, node.failureCount],
  ["peak RSS (MB)", bun.peakRssMB, node.peakRssMB],
  ["avg run (ms)", bun.avgRunMs, node.avgRunMs],
  ["avg launch (ms)", bun.avgLaunchMs, node.avgLaunchMs],
  ["total wall (s)", bun.totalWallSec, node.totalWallSec],
  ["console msgs/load", bun.consoleCountSample, node.consoleCountSample],
];
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
console.error("\n=== Comparison ===");
for (const r of rows) {
  console.error(r.map((v, c) => String(v).padEnd(w[c])).join("  "));
}
console.error("\nWrote " + join(__dirname, "results.json"));

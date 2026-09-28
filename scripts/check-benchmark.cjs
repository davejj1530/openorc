const fs = require("node:fs");

function checkBenchmarks(reports, mode) {
  const checks = [];
  const report = (kind) => {
    const matches = reports.filter((entry) => entry.kind === kind);
    if (matches.length !== 1) throw new Error(`Expected one ${kind} report, got ${matches.length}`);
    if (matches[0].ok === false) throw new Error(`${kind} failed: ${matches[0].error ?? "unknown error"}`);
    return matches[0];
  };
  const check = (name, value, max, min = 0) => {
    checks.push({ name, value, max, min, ok: Number.isFinite(value) && value >= min && value <= max });
  };
  const tasks = (name, measurement, max) => {
    check(`${name}.durationMs`, measurement?.durationMs, Infinity, 1);
    check(`${name}.longTasksTotal`, measurement?.longTasksTotal, max);
    // Counting tasks alone would let a single multi-second freeze pass.
    check(`${name}.longestTaskMs`, measurement?.longestTaskMs, 250);
  };
  if (mode === "bridge") {
    const bench = report("bench");
    const scale = report("scale");
    check("bench.coldStartMs", bench.coldStartMs, 1500);
    tasks("bench.mainThread", bench.mainThread, 5);
    tasks("scale.mainThread", scale.mainThread, 30);
    // macOS working set overstates private memory; this is a regression fence.
    check("scale.workingSetTotalMb", scale.workingSetTotalMb, 1500);
  } else if (mode === "thread") {
    const thread = report("thread-bench");
    check("thread-bench.openMs", thread.openMs, 1500);
    tasks("thread-bench.stream.mainThread", thread.stream?.mainThread, 60);
    tasks("thread-bench.unrelated.mainThread", thread.unrelated?.mainThread, 10);
  } else {
    throw new Error("Usage: node scripts/check-benchmark.cjs bridge|thread <log>");
  }
  return checks;
}

if (require.main === module) {
  try {
    const reports = fs
      .readFileSync(process.argv[3], "utf8")
      .split("\n")
      .filter((line) => line.startsWith("[report] "))
      .map((line) => JSON.parse(line.slice(9)));
    const checks = checkBenchmarks(reports, process.argv[2]);
    for (const { name, value, min, max, ok } of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${value} (budget ${min}..${max})`);
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkBenchmarks };

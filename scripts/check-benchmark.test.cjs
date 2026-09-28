const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkBenchmarks } = require("./check-benchmark.cjs");

const measurement = () => ({ durationMs: 10000, longTasksTotal: 0, longestTaskMs: 0 });
const reports = () => [
  { kind: "bench", coldStartMs: 858, mainThread: measurement() },
  { kind: "scale", workingSetTotalMb: 574, mainThread: measurement() },
];
const pass = (value, mode = "bridge") => checkBenchmarks(value, mode).every((check) => check.ok);

test("display and timer delays do not stand in for browser task measurements", () => {
  const data = reports();
  data[0].longFramesTotal = 93;
  data[0].mainThread.stallsTotal = 9;
  assert.ok(pass(data));
  // Old reports are not evidence of zero long tasks: the new measurement is required.
  delete data[0].mainThread.longTasksTotal;
  assert.ok(!pass(data));
});

test("real freezes, including a single severe freeze, still fail the bridge check", () => {
  const data = reports();
  data[0].mainThread = { durationMs: 10000, longTasksTotal: 6, longestTaskMs: 60 };
  assert.ok(!pass(data));
  data[0].mainThread = { durationMs: 10000, longTasksTotal: 1, longestTaskMs: 500 };
  assert.ok(!pass(data));
});

test("scale and thread workloads enforce their own task limits", () => {
  const data = reports();
  data[1].mainThread.longTasksTotal = 31;
  assert.ok(!pass(data));
  const thread = [{ kind: "thread-bench", openMs: 100, stream: { mainThread: measurement() }, unrelated: { mainThread: measurement() } }];
  assert.ok(pass(thread, "thread"));
  thread[0].stream.mainThread.longTasksTotal = 61;
  assert.ok(!pass(thread, "thread"));
  thread[0].stream.mainThread.longTasksTotal = 0;
  thread[0].unrelated.mainThread.longTasksTotal = 11;
  assert.ok(!pass(thread, "thread"));
});

test("missing, duplicate, failed and malformed measurements fail closed", () => {
  assert.throws(() => pass([]), /Expected one bench/);
  assert.throws(() => pass([...reports(), reports()[0]]), /Expected one bench/);
  assert.throws(() => pass([{ ...reports()[0], ok: false, error: "probe failed" }, reports()[1]]), /probe failed/);
  for (const field of ["longTasksTotal", "longestTaskMs", "durationMs"]) {
    for (const value of [undefined, NaN, Infinity, -1, "0"]) {
      const data = reports();
      data[0].mainThread[field] = value;
      assert.ok(!pass(data), `${field} must reject ${value}`);
    }
  }
  const data = reports();
  data[0].mainThread.durationMs = 0;
  assert.ok(!pass(data));
});

test("startup and memory budgets remain enforced", () => {
  const slow = reports();
  slow[0].coldStartMs = 1501;
  assert.ok(!pass(slow));
  const large = reports();
  large[1].workingSetTotalMb = 1501;
  assert.ok(!pass(large));
});

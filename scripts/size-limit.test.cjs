const { test } = require("node:test");
const assert = require("node:assert/strict");
const { measureSource, offenders, violations, lowerBaseline, productionSource, scan } = require("./size-limit.cjs");
const file = "packages/core/src/example.ts";
const fn = (lines, name = "work") => `function ${name}() {\n${"  perform();\n".repeat(lines - 2)}}\n`;
function measure(text) {
  const result = measureSource(file, text);
  return { files: { [file]: result.lines }, functions: result.functions };
}

test("a new 101-line function fails at its named threshold", () => {
  const baseline = offenders(measure(fn(100)));
  assert.match(violations(measure(fn(101)), baseline)[0], /example.ts::work: lines 101 exceed allowed 100/);
});
test("one-line function and file growth fail against actual recorded values", () => {
  const initial = measure(fn(801));
  const failures = violations(measure(fn(802)), offenders(initial));
  assert.equal(failures.length, 2);
  assert.match(failures[0], /file lines 802 exceed allowed 801/);
  assert.match(failures[1], /lines 802 exceed allowed 801/);
});
test("new branch complexity fails even inside a previously long function", () => {
  const simple = fn(101);
  const complex = simple.replace("  perform();", "  " + "if (ready) perform(); ".repeat(15));
  assert.match(violations(measure(complex), offenders(measure(simple)))[0], /complexity 16 exceed allowed 15/);
});
test("nested function branches belong only to the nested function", () => {
  const result = measureSource(file, `function outer() { function inner() { ${"if (ok) run();".repeat(16)} } }`);
  assert.equal(result.functions[`${file}::outer`].complexity, 1);
  assert.equal(result.functions[`${file}::outer.inner`].complexity, 17);
});
test("shrinking passes and update only lowers or removes allowances", () => {
  const baseline = offenders(measure(fn(120)));
  const smaller = measure(fn(110));
  assert.deepEqual(violations(smaller, baseline), []);
  assert.equal(lowerBaseline(smaller, baseline).functions[`${file}::work`].lines, 110);
  assert.deepEqual(lowerBaseline(measure(fn(100)), baseline).functions, {});
});
test("update refuses growth, renamed offenders and new offenders", () => {
  const baseline = offenders(measure(fn(101)));
  for (const source of [fn(102), fn(101, "renamed"), fn(101) + fn(101, "newWork")]) assert.throws(() => lowerBaseline(measure(source), baseline), /Refusing to increase or add/);
});
test("unrelated line shifts leave qualified function keys and allowances intact", () => {
  const source = `class Service {\n${fn(101).replace("function ", "")} }`;
  const baseline = offenders(measure(source));
  assert.deepEqual(violations(measure("// added documentation\n\n" + source), baseline), []);
  assert.ok(baseline.functions[`${file}::Service.work`]);
});
test("same-named callbacks are distinct and stable across line shifts", () => {
  const source = "function outer() { xs.map(() => run()); xs.map(() => stop()); }";
  const first = measureSource(file, source).functions;
  assert.deepEqual(first, measureSource(file, "\n\n" + source).functions);
  assert.equal(Object.keys(first).length, 3);
});
test("only authored production TypeScript is included", () => {
  assert.equal(productionSource("apps/desktop/src/renderer/View.tsx"), true);
  for (const name of [
    "packages/core/src/x.test.ts",
    "packages/core/src/x.d.ts",
    "apps/desktop/src/renderer/bench-thread.ts",
    "packages/core/src/test-fixtures/fake.ts",
    "packages/core/src/generated/model.ts",
    "scripts/helper.ts",
  ])
    assert.equal(productionSource(name), false, name);
});
test("invalid source is an error rather than a silently reduced allowance", () => {
  assert.throws(() => measureSource(file, "function bad( {"), /invalid TypeScript/);
});

test("unstaged source deletions leave the scan and the lowered baseline", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-size-delete-"));
  const source = path.join(root, file);
  try {
    execFileSync("git", ["init", "--quiet", root]);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, fn(101));
    execFileSync("git", ["add", file], { cwd: root });
    const baseline = offenders(scan(root));
    fs.unlinkSync(source);
    const current = scan(root);
    assert.deepEqual(current, { files: {}, functions: {} });
    assert.deepEqual(lowerBaseline(current, baseline).functions, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dangling source symlink remains a read error", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-size-symlink-"));
  const source = path.join(root, file);
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.symlinkSync(path.join(root, "absent.ts"), source);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
    assert.throws(() => scan(root, undefined, [file]), { code: "ENOENT" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

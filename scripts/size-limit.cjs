#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

const LIMITS = { fileLines: 800, functionLines: 100, complexity: 15 };

function productionSource(file) {
  if (!/^(apps|packages)\/[^/]+\/src\/.*\.[cm]?tsx?$/.test(file)) return false;
  if (/\.(test|spec|d)\.[cm]?tsx?$/.test(file)) return false;
  if (/(^|\/)(fixtures|test-fixtures|__tests__|__mocks__|__generated__|generated|benchmarks)(\/|$)/.test(file)) return false;
  return !/(^|\/)(bench[^/]*|autorun|qa-directory|qa|test-setup)\.[cm]?tsx?$/.test(file);
}

function isFunction(node) {
  return (
    !!node.body &&
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node))
  );
}

function localName(node, source) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (node.name) {
    const name = node.name.getText(source);
    if (ts.isGetAccessorDeclaration(node)) return `get ${name}`;
    if (ts.isSetAccessorDeclaration(node)) return `set ${name}`;
    return name;
  }
  const parent = node.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) return parent.name.getText(source);
  if (ts.isCallExpression(parent)) return `<${parent.expression.getText(source).replace(/\s+/g, " ")} callback>`;
  return "<anonymous>";
}

function branchComplexity(body) {
  let count = 1;
  function visit(node) {
    if (isFunction(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      ts.isCaseClause(node)
    )
      count++;
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) count++;
    ts.forEachChild(node, visit);
  }
  visit(body);
  return count;
}

/** Keys describe lexical owners, never source lines; identical sibling callback names use an ordinal. */
function measureSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`${file}: cannot measure invalid TypeScript`);
  const functions = {};
  const occurrences = new Map();
  function visit(node, owners) {
    let scope = owners;
    if (isFunction(node)) {
      const qualified = [...owners, localName(node, source)].join(".");
      const occurrence = (occurrences.get(qualified) ?? 0) + 1;
      occurrences.set(qualified, occurrence);
      const name = occurrence === 1 ? qualified : `${qualified}#${occurrence}`;
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.end).line;
      functions[`${file}::${name}`] = { lines: end - start + 1, complexity: branchComplexity(node.body) };
      scope = [name];
    } else if (ts.isClassDeclaration(node) && node.name) {
      scope = [...owners, node.name.text];
    } else if (ts.isObjectLiteralExpression(node) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))) {
      scope = [...owners, node.parent.name.getText(source)];
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(source, []);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return { lines: lines.length, functions };
}

function sourceEntryMissing(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function scan(root, readSource = (file) => fs.readFileSync(path.join(root, file), "utf8"), files) {
  const paths = files ?? execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  const measured = { files: {}, functions: {} };
  for (const file of [...new Set(paths)].filter(productionSource).sort()) {
    let source;
    try {
      source = readSource(file);
    } catch (error) {
      // Git still lists an unstaged deletion; present but unreadable files must fail.
      if (error.code === "ENOENT" && sourceEntryMissing(path.join(root, file))) continue;
      throw error;
    }
    const result = measureSource(file, source);
    measured.files[file] = result.lines;
    Object.assign(measured.functions, result.functions);
  }
  return measured;
}

function offenders(measured) {
  const files = Object.fromEntries(Object.entries(measured.files).filter(([, lines]) => lines > LIMITS.fileLines));
  const functions = {};
  for (const [key, values] of Object.entries(measured.functions)) {
    const row = {};
    if (values.lines > LIMITS.functionLines) row.lines = values.lines;
    if (values.complexity > LIMITS.complexity) row.complexity = values.complexity;
    if (Object.keys(row).length) functions[key] = row;
  }
  return { version: 1, thresholds: LIMITS, files, functions };
}

function validateBaseline(baseline) {
  if (baseline.version !== 1 || JSON.stringify(baseline.thresholds) !== JSON.stringify(LIMITS)) throw new Error("Unsupported size baseline thresholds/version");
  for (const [file, value] of Object.entries(baseline.files)) {
    if (!Number.isInteger(value) || value <= LIMITS.fileLines) throw new Error(`Invalid file allowance: ${file}`);
  }
  for (const [key, row] of Object.entries(baseline.functions)) {
    for (const [metric, value] of Object.entries(row)) {
      const minimum = metric === "lines" ? LIMITS.functionLines : LIMITS.complexity;
      if (!["lines", "complexity"].includes(metric) || !Number.isInteger(value) || value <= minimum) throw new Error(`Invalid function allowance: ${key}`);
    }
  }
}

/** Check every current offender, including newly named/moved functions and new metric dimensions. */
function violations(measured, baseline) {
  validateBaseline(baseline);
  const errors = [];
  const current = offenders(measured);
  for (const [file, lines] of Object.entries(current.files)) {
    const allowed = baseline.files[file] ?? LIMITS.fileLines;
    if (lines > allowed) errors.push(`${file}: file lines ${lines} exceed allowed ${allowed}`);
  }
  for (const [key, row] of Object.entries(current.functions)) {
    for (const [metric, value] of Object.entries(row)) {
      const threshold = metric === "lines" ? LIMITS.functionLines : LIMITS.complexity;
      const allowed = baseline.functions[key]?.[metric] ?? threshold;
      if (value > allowed) errors.push(`${key}: ${metric} ${value} exceed allowed ${allowed}`);
    }
  }
  return errors;
}

function lowerBaseline(measured, baseline) {
  const errors = violations(measured, baseline);
  if (errors.length) throw new Error(`Refusing to increase or add allowances:\n${errors.join("\n")}`);
  return offenders(measured);
}

function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--update", "--init"].includes(arg)) || args.length > 1) throw new Error("Usage: node scripts/size-limit.cjs [--update|--init]");
  const root = path.resolve(__dirname, "..");
  const baselinePath = path.join(root, "size-baseline.json");
  const started = performance.now();
  const measured = scan(root);
  if (args.includes("--init")) {
    // Initial capture is explicit and cannot overwrite an existing ratchet.
    fs.writeFileSync(baselinePath, JSON.stringify(offenders(measured), null, 2) + "\n", { flag: "wx" });
  } else {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    if (args.includes("--update")) fs.writeFileSync(baselinePath, JSON.stringify(lowerBaseline(measured, baseline), null, 2) + "\n");
    else {
      const errors = violations(measured, baseline);
      if (errors.length) throw new Error(errors.join("\n"));
    }
  }
  console.log(`Size check passed: ${Object.keys(measured.files).length} production files, ${Object.keys(measured.functions).length} functions in ${Math.round(performance.now() - started)} ms.`);
}

module.exports = { LIMITS, productionSource, measureSource, scan, offenders, violations, lowerBaseline };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

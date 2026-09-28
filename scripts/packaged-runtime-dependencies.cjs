const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules, createRequire } = require("node:module");

// These load outside the compiled bundles. AJV also emits require() calls in
// generated validation code, which cannot be found as ordinary import syntax.
const runtimeRoots = ["electron-updater", "node-pty", "sqlite-vec", "fastembed", "onnxruntime-node", "ajv", "ajv-formats"];
const noticeName = "{package.json,*[Ll][Ii][Cc][Ee][Nn][SsCc][Ee]*,*[Nn][Oo][Tt][Ii][Cc][Ee]*,*[Cc][Oo][Pp][Yy][Ii][Nn][Gg]*,*[Cc][Oo][Pp][Yy][Rr][Ii][Gg][Hh][Tt]*,[Rr][Ee][Aa][Dd][Mm][Ee]*}";

function packageDirectory(from, name) {
  const require = createRequire(path.join(from, "package.json"));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
  }
  return null;
}

/** Read installed production dependencies, including optional and peer edges. */
function dependencyGraph(appDir) {
  const graph = new Map();
  function visit(directory) {
    if (graph.has(directory)) return;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const node = { name: manifest.name, dependencies: [], names: [] };
    graph.set(directory, node);
    const optional = { ...manifest.peerDependencies, ...manifest.optionalDependencies };
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(optional)])) {
      node.names.push(name);
      const dependency = packageDirectory(directory, name);
      assert.ok(dependency || name in optional, `Missing production dependency ${name} required by ${manifest.name}`);
      if (!dependency) continue;
      node.dependencies.push(dependency);
      visit(dependency);
    }
  }
  visit(fs.realpathSync(appDir));
  return graph;
}

function runtimeDependencies(graph, roots = runtimeRoots) {
  const names = new Set(roots);
  const visited = new Set();
  function visit(directory) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const node = graph.get(directory);
    names.add(node.name);
    // Missing platform-specific optional packages still need to be allowed on
    // the runner where they are installed, e.g. sqlite-vec-windows-x64.
    for (const name of node.names) names.add(name);
    for (const dependency of node.dependencies) visit(dependency);
  }
  for (const name of roots) {
    const matches = [...graph].filter(([, node]) => node.name === name);
    assert.ok(matches.length, `Runtime dependency ${name} is not in the production graph`);
    for (const [directory] of matches) visit(directory);
  }
  return names;
}

function runtimeFilePatterns(names) {
  return [
    "!**/node_modules/**",
    ...[...names].sort().map((name) => `**/node_modules/${name}/**`),
    // Keep metadata and upstream notices at any depth, including notice folders.
    `**/node_modules/**/${noticeName}`,
    `**/node_modules/**/${noticeName}/**`,
  ];
}

function compiledFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return compiledFiles(file);
    return /\.[cm]?js$/.test(entry.name) ? [file] : [];
  });
}

/** Fail closed when a new external import is not covered by the runtime graph. */
function verifyCompiledImports(appDir, names) {
  const ts = require("typescript");
  const builtins = new Set([...builtinModules, "electron"]);
  const imports = new Set();
  const inspect = (specifier, file, renderer) => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) return;
    if (!renderer && (specifier.startsWith("node:") || builtins.has(specifier))) return;
    const name = specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");
    assert.ok(!renderer && names.has(name), `Uncovered compiled import ${specifier} in ${file}; review runtime dependencies before packaging`);
    imports.add(name);
  };
  for (const section of ["main", "preload", "renderer"]) {
    for (const file of compiledFiles(path.join(appDir, "out", section))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const renderer = section === "renderer";
      function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) inspect(node.moduleSpecifier.text, file, renderer);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
          const argument = node.arguments[0];
          assert.ok(argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)), `Nonliteral compiled module load in ${file}; review before packaging`);
          inspect(argument.text, file, renderer);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  return imports;
}

function packagedRuntimePatterns(appDir) {
  const names = runtimeDependencies(dependencyGraph(appDir));
  verifyCompiledImports(appDir, names);
  console.log(`Keeping ${names.size} runtime dependency names; bundled dependencies retain metadata and notices only`);
  return runtimeFilePatterns(names);
}

module.exports = { dependencyGraph, runtimeDependencies, runtimeFilePatterns, verifyCompiledImports, packagedRuntimePatterns };

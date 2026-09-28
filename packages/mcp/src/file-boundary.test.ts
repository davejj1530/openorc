import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileBoundaryAnswer } from "./file-boundary.js";

test("permits only real paths inside the boundary, including files that do not exist yet", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "openorc-file-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, "plans");
  mkdirSync(allowed);
  symlinkSync(root, path.join(allowed, "escape"));
  for (const outside of ["ask", "deny"] as const) {
    const decision = (file_path: string) => fileBoundaryAnswer({ root: allowed, cwd: root, outside }, { tool_input: { file_path } }).hookSpecificOutput?.permissionDecision;
    assert.equal(decision("plans/new.md"), undefined);
    assert.equal(decision(path.join(allowed, "drafts", "new.md")), undefined);
    assert.equal(decision("plans/escape/project.md"), outside);
    assert.equal(decision("plans/../project.md"), outside);
    assert.equal(decision("plans"), outside);
  }
  const notebook = fileBoundaryAnswer({ root: allowed, cwd: root, outside: "ask" }, { tool_input: { notebook_path: "notes.ipynb" } });
  assert.equal(notebook.hookSpecificOutput?.permissionDecision, "ask");
  assert.throws(() => fileBoundaryAnswer({ root: allowed, cwd: root, outside: "deny" }, { tool_input: {} }), /names no file/);
});

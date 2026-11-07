import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderPath, type EditorRequest, type EditorResult } from "@openorc/protocol";
import { EditorService } from "./service.js";
import type { IntelligenceEngine } from "./worker-intelligence.js";

let root: string;
let outside: string;
const path = FolderPath.parse("main.ts");
const input: EditorRequest = { path, documents: [{ path, text: "const value = 1;" }], query: { kind: "analysis" } };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "openorc-editor-scope-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "openorc-editor-outside-")));
  await writeFile(join(root, path), "const value = 1;");
});
afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});
function setup(result: EditorResult = { kind: "analysis", diagnostics: [], symbols: [] }) {
  const engine = { query: vi.fn<IntelligenceEngine["query"]>().mockResolvedValue(result), close: vi.fn<IntelligenceEngine["close"]>().mockResolvedValue() };
  return { engine, service: new EditorService(engine), folder: { root, readOnly: null } };
}

it("rejects a symlink buffer that escapes the worktree before the engine sees it", async () => {
  const { service, engine, folder } = setup();
  await writeFile(join(outside, "secret.ts"), "private");
  await symlink(join(outside, "secret.ts"), join(root, "link.ts"));
  await expect(service.query(folder, { ...input, documents: [...input.documents, { path: FolderPath.parse("link.ts"), text: "private" }] })).rejects.toThrow("outside");
  expect(engine.query).not.toHaveBeenCalled();
});

it("allows an unsaved deleted file whose parent remains inside the worktree", async () => {
  const { service, engine, folder } = setup();
  await rm(join(root, path));
  expect(await service.query(folder, input)).toMatchObject({ kind: "analysis" });
  expect(engine.query).toHaveBeenCalledWith(expect.objectContaining({ root, documents: input.documents }));
});

it("drops definition locations and fixes that would leave through a symlink", async () => {
  await writeFile(join(outside, "secret.ts"), "private");
  await symlink(join(outside, "secret.ts"), join(root, "link.ts"));
  const target = { path: FolderPath.parse("link.ts"), from: 0, to: 1, line: 1, column: 1, endLine: 1, endColumn: 2, preview: "private" };
  const { service, engine, folder } = setup({ kind: "definition", locations: [target], truncated: false });
  expect(await service.query(folder, input)).toEqual({ kind: "definition", locations: [], truncated: false });
  engine.query.mockResolvedValue({ kind: "fixes", fixes: [{ title: "Change it", changes: [{ path: target.path, before: "private", after: "changed" }] }] });
  expect(await service.query(folder, { ...input, query: { kind: "fixes", from: 0, to: 1, code: 2552 } })).toEqual({ kind: "fixes", fixes: [] });
});

it("offers no quick fixes in a read-only review or team workspace", async () => {
  const { service, engine } = setup();
  expect(await service.query({ root, readOnly: "Review copy" }, { ...input, query: { kind: "fixes", from: 0, to: 1, code: 2552 } })).toEqual({ kind: "fixes", fixes: [] });
  expect(engine.query).not.toHaveBeenCalled();
});

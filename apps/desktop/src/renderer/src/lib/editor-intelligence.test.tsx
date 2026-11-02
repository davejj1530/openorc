import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileRpcParams, FileVersion, FolderPath, type EditorFix, type FileRead } from "@openorc/protocol";
import { queryClient } from "./client";
import { fileKey, useDrafts } from "./file-drafts";
import { applyEditorFix, editorDocuments } from "./editor-intelligence";

const rpc = vi.hoisted(() => ({ call: vi.fn<(method: string, params: unknown) => Promise<FileRead>>() }));
vi.mock("./rpc", () => ({ core: { call: rpc.call } }));
vi.mock("./client", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});
const scope = { kind: "thread", id: "thread" } as const;
const version = FileVersion.parse("1".repeat(64));
const file = (path: string, text: string, root = "/repo"): FileRead => ({ kind: "file", root, path: FolderPath.parse(path), absolutePath: `${root}/${path}`, text, version, readOnly: null });
let disk: Map<string, FileRead>;
beforeEach(() => {
  queryClient.clear();
  useDrafts.setState({ ready: true, keys: new Set(), loaded: new Map(), failed: false });
  disk = new Map();
  rpc.call.mockReset();
  rpc.call.mockImplementation(async (method, params) => {
    if (method !== "files.read") throw new Error(`A quick fix must not call ${method}`);
    const { path } = fileRpcParams["files.read"].parse(params);
    const read = disk.get(path);
    if (!read) throw new Error("Missing fixture file");
    return read;
  });
});
afterEach(() => queryClient.clear());
function cached(read: FileRead, draft: string | null = null) {
  queryClient.setQueryData(["files.read", { scope, path: read.path }], read);
  useDrafts.setState((state) => ({ loaded: new Map(state.loaded).set(fileKey(read), draft === null ? null : { text: draft, base: version }) }));
  disk.set(read.path, read);
}
const fix: EditorFix = {
  title: "Fix both",
  changes: [
    { path: FolderPath.parse("main.ts"), before: "wrong();\n", after: "right();\n" },
    { path: FolderPath.parse("math.ts"), before: "export const wrong = 1;\n", after: "export const right = 1;\n" },
  ],
};

it("sends the current text and only unsaved buffers from the same worktree", () => {
  cached(file("main.ts", "old"), "older draft");
  cached(file("math.ts", "saved"), "unsaved\r\n");
  cached(file("other.ts", "other", "/other-worktree"), "private draft");
  expect(editorDocuments("/repo", "main.ts", "current\r\n")).toEqual(
    expect.arrayContaining([
      { path: "main.ts", text: "current\n" },
      { path: "math.ts", text: "unsaved\n" },
    ]),
  );
  expect(editorDocuments("/repo", "main.ts", "current")).toHaveLength(2);
  queryClient.clear();
  expect(editorDocuments("/repo", "main.ts", "current")).toEqual([
    { path: "main.ts", text: "current" },
    { path: "math.ts", text: "unsaved\n" },
  ]);
});

it("stages every quick-fix change as a draft without writing files, preserving CRLF", async () => {
  const first = file("main.ts", "wrong();\r\n");
  const second = file("math.ts", "export const wrong = 1;\n");
  cached(first);
  cached(second);
  await applyEditorFix(scope, "/repo", fix);
  expect(useDrafts.getState().loaded.get(fileKey(first))?.text).toBe("right();\r\n");
  expect(useDrafts.getState().loaded.get(fileKey(second))?.text).toBe("export const right = 1;\n");
  expect(rpc.call.mock.calls.every(([method]) => method === "files.read")).toBe(true);
  expect(disk.get("main.ts")).toEqual(first);
});

it("applies none of a fix if any buffer changed after the fix was offered", async () => {
  const first = file("main.ts", "wrong();\n");
  const second = file("math.ts", "export const wrong = 1;\n");
  cached(first);
  cached(second, "newer typing");
  await expect(applyEditorFix(scope, "/repo", fix)).rejects.toThrow("code changed");
  expect(useDrafts.getState().loaded.get(fileKey(first))).toBeNull();
  expect(useDrafts.getState().loaded.get(fileKey(second))?.text).toBe("newer typing");
});

it("refuses a fix after the conversation moves to a different worktree", async () => {
  cached(file("main.ts", "wrong();\n", "/new-worktree"));
  await expect(applyEditorFix(scope, "/repo", { ...fix, changes: fix.changes.slice(0, 1) })).rejects.toThrow("cannot be edited");
});

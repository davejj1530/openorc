import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Db, LedgerWriter, completedToolCall, listEvents, projects, runs, threads } from "@openorc/db";
import type { AgentEvent } from "@openorc/protocol";
import { ToolImageStore } from "./tool-images.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
let dir: string;
let db: Db;
let store: ToolImageStore;
let runId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-tool-images-"));
  db = Db.memory();
  store = new ToolImageStore(dir);
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "t", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  runId = runs.insert(db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id;
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const outputs: Array<[string, unknown]> = [
  [
    "Claude",
    [
      { type: "text", text: "shot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    ],
  ],
  ["MCP", { content: [{ type: "image", mimeType: "image/png", data: png }], structuredContent: { ok: true } }],
  ["an MCP resource", { content: [{ type: "resource", resource: { uri: "screen://1", mimeType: "image/png", blob: png } }] }],
  ["Codex metadata", { content: [{ type: "text", text: "tab" }], _meta: { screenshot: { url: `data:image/png;base64,${png}` } } }],
];

it.each(outputs)("stores %s images as files in the ledger and gives them back to readers that need the bytes", (_shape, output) => {
  const writer = new LedgerWriter(db, { storeImage: (id, image) => store.save(id, image) });
  writer.push({ type: "tool.completed", runId, ts: 1, toolCallId: "c1", name: "Read", output, isError: false } as AgentEvent);
  writer.flush();
  const [stored] = listEvents(db, runId);
  const text = JSON.stringify(stored);
  expect(text).not.toContain(png);
  expect(text).toMatch(/openorc-asset:\/\/tool-images\/run-1\/[a-f0-9-]+\.png/);
  expect(store.inline(completedToolCall(db, runId, "c1")?.output)).toEqual(output);
});

it("leaves outputs without images as the same object, and keeps an image inline when it cannot be written", () => {
  const plain = { content: [{ type: "text", text: "no images" }] };
  const writer = new LedgerWriter(db, { storeImage: () => null });
  writer.push({ type: "tool.completed", runId, ts: 1, toolCallId: "c1", name: "Read", output: outputs[0]![1], isError: false });
  writer.flush();
  expect(JSON.stringify(listEvents(db, runId))).toContain(png);
  expect(store.inline(plain)).toBe(plain);
});

it("removes the folders of runs that are gone and keeps the rest", async () => {
  expect(store.save("run-1", { mime: "image/png", data: png })).toMatch(/^openorc-asset:\/\/tool-images\/run-1\//);
  store.save("run-2", { mime: "image/png", data: png });
  expect(await store.prune((id) => id === "run-1")).toBe(1);
  expect(await readdir(path.join(dir, "tool-images"))).toEqual(["run-1"]);
});

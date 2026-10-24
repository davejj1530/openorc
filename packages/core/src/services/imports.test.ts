import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Db, LedgerWriter, listEvents, projects, runs } from "@openorc/db";
import { ImportService } from "./imports.js";
import { ToolImageStore } from "./tool-images.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const silent = { info() {}, warn() {}, error() {} };
let dir: string;
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-imports-"));
  db = Db.memory();
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

it("stores an imported session's tool images as files, as a live run does", async () => {
  const project = projects.insert(db, { name: "demo", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
  const rows = [
    { type: "user", sessionId: "s-1", cwd: dir, timestamp: "2026-09-01T10:00:00.000Z", uuid: "u1", message: { role: "user", content: "Take a screenshot" } },
    { type: "assistant", sessionId: "s-1", timestamp: "2026-09-01T10:00:01.000Z", uuid: "a1", message: { id: "m1", content: [{ type: "tool_use", id: "shot", name: "Screenshot", input: {} }] } },
    {
      type: "user",
      sessionId: "s-1",
      timestamp: "2026-09-01T10:00:02.000Z",
      uuid: "u2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shot", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] },
    },
    { type: "assistant", sessionId: "s-1", timestamp: "2026-09-01T10:00:03.000Z", uuid: "a2", message: { id: "m2", content: [{ type: "text", text: "Done." }] } },
  ];
  const file = path.join(dir, "s-1.jsonl");
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const service = new ImportService(db, new LedgerWriter(db), () => {}, silent, new ToolImageStore(dir));

  const [thread] = await service.import(project.id, [{ agent: "claude", path: file }]);
  const [run] = runs.listForThread(db, thread!.id);
  const stored = listEvents(db, run!.id).find((event) => event.type === "tool.completed" && event.toolCallId === "shot");
  const text = JSON.stringify(stored);
  expect(text).not.toContain(png);
  const url = /openorc-asset:\/\/(tool-images\/[A-Za-z0-9-]+\/[a-f0-9-]+\.png)/.exec(text);
  expect(url && existsSync(path.join(dir, url[1]!))).toBe(true);
});

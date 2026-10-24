import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { settings, threads } from "@openorc/db";
import { WORKSPACE_ID, type Thread } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let dataDir: string;
let core: OpenOrc;
let thread: Thread;
const call = rpcClient(() => core);

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-update-rpc-"));
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  thread = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Notes", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
});
afterEach(async () => {
  await core.close();
  await rm(dataDir, { recursive: true, force: true });
});

it.each([
  ["too large to read back", 2 ** 62],
  ["past the largest safe integer", Number.MAX_SAFE_INTEGER + 2],
  ["before 1970", -1],
  ["between two milliseconds", Date.UTC(2026, 9, 24, 12) + 0.5],
])("refuses a snooze %s from any window, so every thread list still reads", async (_case, snoozedUntil) => {
  await expect(call("threads.update", { id: thread.id, patch: { snoozedUntil } })).rejects.toThrow();
  expect(await call("threads.get", { id: thread.id })).toMatchObject({ snoozedUntil: null });
  expect(await call("threads.list", { filter: "all" })).toEqual([expect.objectContaining({ id: thread.id, snoozedUntil: null })]);
});

it("snoozes a thread until a time the list reads back, and wakes it", async () => {
  const until = Date.now() + 3_600_000;
  await call("threads.update", { id: thread.id, patch: { snoozedUntil: until } });
  expect(await call("threads.list", { filter: "all" })).toEqual([expect.objectContaining({ id: thread.id, snoozedUntil: until })]);
  await call("threads.update", { id: thread.id, patch: { snoozedUntil: null } });
  expect(await call("threads.get", { id: thread.id })).toMatchObject({ snoozedUntil: null });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { orclings, settings, threads } from "@openorc/db";
import { defaultOrclingLook, WORKSPACE_ID, type RpcParams, type Thread } from "@openorc/protocol";
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

it("pages parent threads through RPC without spending slots on descendants and retains the selected family", async () => {
  const insert = (title: string) => threads.insert(core.db, { projectId: WORKSPACE_ID, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const child = insert("Child");
  const nested = insert("Nested");
  const other = insert("Other");
  threads.update(core.db, child.id, { parentThreadId: thread.id });
  threads.update(core.db, nested.id, { parentThreadId: child.id });
  const now = Date.now();
  core.db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(now + 1000, nested.id);
  const filter: RpcParams<"threads.list"> = { projectIds: [WORKSPACE_ID], includeChildren: true, orderBy: "activity", limit: 1 };
  const page = await call("threads.list", filter);
  expect(page.map((row) => row.id).sort()).toEqual([thread.id, child.id, nested.id].sort());
  core.db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(now + 2000, other.id);
  const selected = await call("threads.list", { ...filter, selectedId: nested.id });
  expect(selected.map((row) => row.id).sort()).toEqual([thread.id, child.id, nested.id, other.id].sort());
  expect(await call("threads.list", { limit: 1 })).toHaveLength(1);
});

it("filters started children independently while subagents inherit their full parent's visibility", async () => {
  const insert = (title: string) => threads.insert(core.db, { projectId: WORKSPACE_ID, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const started = insert("Independent");
  const subagent = insert("Inherited");
  const nested = insert("Nested");
  threads.update(core.db, started.id, { parentThreadId: thread.id });
  threads.update(core.db, subagent.id, { parentThreadId: thread.id, parentRelation: "subagent" });
  threads.update(core.db, nested.id, { parentThreadId: started.id, parentRelation: "subagent" });
  threads.update(core.db, thread.id, { archivedAt: 10 });
  const list = (filter: "active" | "archived", pinnedOnly = false) => call("threads.list", { includeChildren: true, filter, pinnedOnly, selectedId: started.id });
  expect((await list("active")).map((t) => t.id).sort()).toEqual([started.id, nested.id].sort());
  expect((await list("archived")).map((t) => t.id).sort()).toEqual([thread.id, subagent.id].sort());
  threads.update(core.db, thread.id, { archivedAt: null });
  threads.update(core.db, started.id, { archivedAt: 10 });
  expect((await list("active")).map((t) => t.id).sort()).toEqual([thread.id, subagent.id].sort());
  threads.update(core.db, started.id, { archivedAt: null, pinnedAt: 10 });
  expect((await list("active", true)).map((t) => t.id).sort()).toEqual([started.id, nested.id].sort());
});

it("lists started children of an Orcling home as full conversations", async () => {
  orclings.insert(core.db, {
    id: "orcling",
    threadId: thread.id,
    draft: { name: "Fixture", look: defaultOrclingLook, settings: { agent: "claude", model: "fixture", effort: null, fastMode: false }, permission: "allow", claudeAccountId: "claude-cli" },
  });
  const child = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Started", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  threads.update(core.db, child.id, { parentThreadId: thread.id, parentRelation: "started" });
  expect((await call("threads.list", { includeChildren: true })).map((t) => t.id)).toEqual([child.id]);
});

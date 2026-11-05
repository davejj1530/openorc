import { afterEach, describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { memories, type MemoryInput } from "./memories.js";
import { memoryChangesSince, mergeMemories } from "./memory-merge.js";
import { projects, runs, threads } from "./repos.js";

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function side() {
  const db = Db.memory();
  open.push(db);
  const project = projects.insert(db, { name: "App", rootPath: `/app-${open.length}`, gitRemote: null, defaultBranch: null, settings: {} });
  return { db, projectId: project.id };
}
type Side = ReturnType<typeof side>;

const fact = (projectId: string, title: string, extra: Partial<MemoryInput> = {}): MemoryInput => ({ projectId, type: "convention", title, body: `${title}.`, source: "agent", ...extra });

/** One exchange as the Mac drives it: its changes up, the brain's back with what the brain kept, and once more if the Mac kept any. */
function exchange(mac: Side, brain: Side, cursors: { sent: number; heard: number }) {
  const up = memoryChangesSince(mac.db, mac.projectId, cursors.sent);
  const there = mergeMemories(brain.db, brain.projectId, up);
  const down = memoryChangesSince(brain.db, brain.projectId, cursors.heard);
  const here = mergeMemories(mac.db, mac.projectId, { rows: [...down.rows, ...there.kept], removed: down.removed });
  if (here.kept.length) mergeMemories(brain.db, brain.projectId, { rows: here.kept, removed: memoryChangesSince(mac.db, mac.projectId, cursors.sent).removed });
  cursors.sent = up.next;
  cursors.heard = down.next;
}

/** What a side holds, as both should agree on it. */
const held = ({ db, projectId }: Side) =>
  memories
    .list(db, { projectId, statuses: ["active", "stale", "retracted", "superseded"] })
    .map(({ id, title, body, status, source, topicKey, updatedAt, files }) => ({ id, title, body, status, source, topicKey, updatedAt, files }))
    .sort((a, b) => a.id.localeCompare(b.id));

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

describe("project memory between the Mac and the cloud brain", () => {
  it("leaves both copies holding every fact either side recorded, files included", () => {
    const [mac, brain] = [side(), side()];
    memories.upsert(mac.db, { ...fact(mac.projectId, "Use pnpm"), files: ["package.json"] });
    memories.upsert(brain.db, fact(brain.projectId, "Tests run with vitest"));
    exchange(mac, brain, { sent: 0, heard: 0 });
    expect(held(mac).map((row) => row.title)).toEqual(expect.arrayContaining(["Use pnpm", "Tests run with vitest"]));
    expect(held(mac)).toEqual(held(brain));
    expect(held(brain).find((row) => row.title === "Use pnpm")?.files).toEqual(["package.json"]);
  });

  it("keeps the newer of one record whole, a retraction included", async () => {
    const [mac, brain] = [side(), side()];
    const cursors = { sent: 0, heard: 0 };
    const { memory } = memories.upsert(mac.db, fact(mac.projectId, "Deploys go through CI"));
    exchange(mac, brain, cursors);
    await tick();
    memories.update(mac.db, memory.id, { body: "Deploys go through CI, never by hand." });
    await tick();
    memories.feedback(brain.db, memory.id, "wrong");
    exchange(mac, brain, cursors);
    expect(held(mac)).toEqual(held(brain));
    expect(memories.get(mac.db, memory.id)).toMatchObject({ status: "retracted", body: "Deploys go through CI." });
  });

  it("keeps one fact per topic: the newer replaces the older on both sides", async () => {
    const [mac, brain] = [side(), side()];
    const older = memories.upsert(mac.db, fact(mac.projectId, "Node 22", { topicKey: "runtime" })).memory;
    await tick();
    const newer = memories.upsert(brain.db, fact(brain.projectId, "Node 24", { topicKey: "runtime" })).memory;
    exchange(mac, brain, { sent: 0, heard: 0 });
    expect(memories.activeOnTopic(mac.db, mac.projectId, "runtime")?.id).toBe(newer.id);
    expect(memories.get(mac.db, older.id)).toBeNull();
    expect(held(mac)).toEqual(held(brain));
  });

  it("keeps what the user wrote on a topic over a newer fact an agent recorded", async () => {
    const [mac, brain] = [side(), side()];
    const cursors = { sent: 0, heard: 0 };
    exchange(mac, brain, cursors);
    const mine = memories.upsert(mac.db, { ...fact(mac.projectId, "Tabs", { topicKey: "indent" }), source: "user" }).memory;
    await tick();
    memories.upsert(brain.db, fact(brain.projectId, "Two spaces", { topicKey: "indent" }));
    exchange(mac, brain, cursors);
    expect(memories.activeOnTopic(brain.db, brain.projectId, "indent")?.id).toBe(mine.id);
    expect(held(mac)).toEqual(held(brain));
  });

  it("keeps a winner the other side never had, though it was sent long before", async () => {
    const [mac, brain] = [side(), side()];
    const cursors = { sent: 0, heard: 0 };
    const mine = memories.upsert(mac.db, { ...fact(mac.projectId, "Tabs", { topicKey: "indent" }), source: "user" }).memory;
    const third = side();
    exchange(mac, third, cursors);
    // The Mac's cursor is past its own fact now, as if the brain it went to had been set up again since.
    await tick();
    memories.upsert(brain.db, fact(brain.projectId, "Two spaces", { topicKey: "indent" }));
    exchange(mac, brain, { sent: cursors.sent, heard: 0 });
    expect(memories.activeOnTopic(brain.db, brain.projectId, "indent")?.id).toBe(mine.id);
    expect(held(mac)).toEqual(held(brain));
  });

  it("drops a removed fact on the other side and never takes it back", async () => {
    const [mac, brain] = [side(), side()];
    const cursors = { sent: 0, heard: 0 };
    const { memory } = memories.upsert(brain.db, fact(brain.projectId, "Old build step"));
    exchange(mac, brain, cursors);
    const stale = memories.get(brain.db, memory.id)!;
    memories.remove(mac.db, memory.id);
    exchange(mac, brain, cursors);
    expect(memories.get(brain.db, memory.id)).toBeNull();
    expect(mergeMemories(mac.db, mac.projectId, { rows: [stale], removed: [] }).written).toEqual([]);
    expect(memories.get(mac.db, memory.id)).toBeNull();
  });

  it("changes nothing when the same changes come twice", () => {
    const [mac, brain] = [side(), side()];
    memories.upsert(mac.db, fact(mac.projectId, "Use pnpm"));
    const up = memoryChangesSince(mac.db, mac.projectId, 0);
    expect(mergeMemories(brain.db, brain.projectId, up).written).toHaveLength(1);
    expect(mergeMemories(brain.db, brain.projectId, up)).toEqual({ written: [], deleted: [], kept: [] });
  });

  it("reads only what changed since its cursor, and names a run only where that run is", async () => {
    const [mac, brain] = [side(), side()];
    const thread = threads.insert(mac.db, { projectId: mac.projectId, title: "T", agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
    runs.insert(mac.db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
    memories.upsert(mac.db, fact(mac.projectId, "First", { sourceRunId: "run-1" }));
    // A row written in the millisecond a read starts is sent again at the next read, which taking twice allows.
    await tick();
    const first = memoryChangesSince(mac.db, mac.projectId, 0);
    await tick();
    memories.upsert(mac.db, fact(mac.projectId, "Second"));
    expect(memoryChangesSince(mac.db, mac.projectId, first.next).rows.map((row) => row.title)).toEqual(["Second"]);
    mergeMemories(brain.db, brain.projectId, first);
    expect(memories.list(brain.db, { projectId: brain.projectId })[0]).toMatchObject({ title: "First", sourceRunId: null, projectId: brain.projectId });
  });
});

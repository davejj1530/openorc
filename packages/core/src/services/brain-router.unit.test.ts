import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claudeAccounts, Db, projects, relocations, tasks } from "@openorc/db";
import { NOT_ON_BRAIN, threadListCompare, type CorePush, type InboxList, type OwnerReach, type RpcMethod, type RpcRequest, type Task, type ThreadSummary } from "@openorc/protocol";
import type { RpcReply } from "../transport.js";
import { until } from "../test-fixtures/fake-claude.js";
import { BrainOutOfReach, type BrainLink, type BrainPush } from "./brain-link.js";
import { BrainRouter } from "./brain-router.js";

const row = (id: string, lastActivityAt: number, projectId: string, worktreePath: string | null = null) =>
  ({ id, projectId, worktreePath, pinnedAt: null, archivedAt: null, doneAt: null, lastActivityAt, parentThreadId: null }) as unknown as ThreadSummary;

/** A host's answer to a page of the thread list, as its ledger pages it. */
function paged(rows: ThreadSummary[], params: { limit?: number; offset?: number }): ThreadSummary[] {
  const sorted = [...rows].sort(threadListCompare());
  const offset = params.offset ?? 0;
  return sorted.slice(offset, params.limit ? offset + params.limit : undefined);
}

interface Answers {
  mac?: ThreadSummary[];
  cloud?: ThreadSummary[];
  cloudInbox?: InboxList;
  mirrors?: Record<string, string>;
  listMs?: number;
  /** How a wake for a window's cloud start goes. */
  wake?: () => Promise<void>;
  /** CloudBrain installs a newer brain meanwhile. */
  updating?: boolean;
  /** Why new cloud threads wait, as while the brain moves. */
  holding?: string;
}

function harness(answers: Answers = {}) {
  const interest: string[][] = [];
  const windows: CorePush[] = [];
  const reaches: ((reach: OwnerReach) => void)[] = [];
  const pushes: ((push: BrainPush) => void)[] = [];
  const asked: RpcMethod[] = [];
  const sent: { method: RpcMethod; params: Record<string, unknown> }[] = [];
  /** Each call that woke the brain, or would have. */
  const woke: RpcMethod[] = [];
  const link = {
    reach: "live" as OwnerReach,
    onPush: (listener: (push: BrainPush) => void) => void pushes.push(listener),
    onReach: (listener: (reach: OwnerReach) => void) => void reaches.push(listener),
    setInterest: (runIds: readonly string[]) => void interest.push([...runIds]),
    call: async (method: RpcMethod, params: Record<string, unknown>, options: { wake: boolean }) => {
      if (options.wake) woke.push(method);
      else if (link.reach !== "live") throw new BrainOutOfReach(link.reach);
      asked.push(method);
      sent.push({ method, params });
      if (method === "attachments.save") return { path: `/brain/attachments/${sent.length}.png`, url: "" };
      if (method === "attachments.saveFile") return { path: `/brain/attachments/${sent.length}-${String(params["name"])}`, name: params["name"], bytes: 1 };
      if (method === "threads.start") {
        const started = row(String(params["id"] ?? "new-thread"), 99, params["projectId"] as string);
        answers.cloud = [...(answers.cloud ?? []), started];
        return { thread: started, run: null };
      }
      if (method === "threads.list") {
        // The brain's answer takes a moment, as over the link.
        if (answers.listMs) await new Promise((resolve) => setTimeout(resolve, answers.listMs));
        return paged(answers.cloud ?? [], params);
      }
      if (method === "inbox.list") return answers.cloudInbox ?? { items: [] };
      if (method === "threads.get") return (answers.cloud ?? []).find((each) => each.id === params["id"]) ?? null;
      return { events: [], fromTurn: 0, live: false };
    },
  };
  const db = Db.memory();
  const router = new BrainRouter({
    db,
    link: link as unknown as BrainLink,
    wake: () => answers.wake?.() ?? Promise.resolve(),
    updating: () => answers.updating ?? false,
    service: async () => "agent37",
    holding: async () => answers.holding ?? null,
    mirrors: { folder: (id) => answers.mirrors?.[id] ?? null, isOpen: () => false, pull: async () => {} },
    local: async (request) => ({
      type: "rpc.result",
      id: request.id,
      result: request.method === "inbox.list" ? { items: [] } : paged(answers.mac ?? [], (request.params ?? {}) as never),
    }),
    windows: { push: (push) => void windows.push(push) },
    mapping: async () => ({ toCloud: (id) => (id === "mac-project" ? "cloud-project" : null), toMac: (id) => (id === "cloud-project" ? "mac-project" : null) }),
    notificationsOn: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  });
  return {
    router,
    db,
    link,
    interest,
    windows,
    asked,
    sent,
    woke,
    reach: (next: OwnerReach) => reaches.forEach((listener) => listener(next)),
    push: (push: BrainPush) => pushes.forEach((listener) => listener(push)),
  };
}

let id = 0;
async function ask(router: BrainRouter, method: RpcMethod, params: unknown, refresh?: true): Promise<unknown> {
  const reply: RpcReply = await router.handle({ type: "rpc", id: ++id, method, params, ...(refresh ? { refresh } : {}) } as RpcRequest);
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result;
}

/** The first ask answers from this Mac alone and refreshes the brain's part behind it; the second has both. */
async function listedTwice(router: BrainRouter, windows: CorePush[], method: "threads.list" | "inbox.list", params: unknown): Promise<unknown> {
  const heard = windows.length;
  await ask(router, method, params);
  await until(() => windows.length > heard);
  return ask(router, method, params);
}

afterEach(() => {
  vi.useRealTimers();
});

it("lets the brain's interest in a run lapse five minutes after a window last read it, with no further call", async () => {
  vi.useFakeTimers();
  const { router, interest } = harness();
  await ask(router, "events.page", { runId: "cloud-run" });
  expect(interest.at(-1)).toEqual(["cloud-run"]);
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
  expect(interest.at(-1)).toEqual(["cloud-run"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(interest.at(-1)).toEqual([]);
  router.close();
});

it("puts the brain's waiting approvals on this Mac's project, with no brain folder", async () => {
  const thread = row("cloud-thread", 1, "cloud-project", "/vercel/sandbox/openorc-brain/data/worktrees/x");
  const cloudInbox: InboxList = { items: [{ kind: "thread", thread, runId: "cloud-run", reason: "approval", detail: "Approve" }] };
  const { router, windows } = harness({ cloudInbox });
  const inbox = (await listedTwice(router, windows, "inbox.list", {})) as InboxList;
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({ kind: "thread", runId: "cloud-run", thread: { id: "cloud-thread", projectId: "mac-project", worktreePath: null } });
  router.close();
});

it("pages the merged list without skipping either host's rows", async () => {
  const mac = [row("m4", 40, "mac-project"), row("m2", 20, "mac-project")];
  const cloud = [row("c3", 30, "cloud-project"), row("c1", 10, "cloud-project")];
  const { router, windows } = harness({ mac, cloud });
  const first = (await listedTwice(router, windows, "threads.list", { limit: 2 })) as ThreadSummary[];
  const second = (await listedTwice(router, windows, "threads.list", { limit: 2, offset: 2 })) as ThreadSummary[];
  expect([...first, ...second].map((each) => each.id)).toEqual(["m4", "c3", "m2", "c1"]);
  router.close();
});

it("marks a listed cloud row open on this Mac with its read-only copy", async () => {
  const { router, windows } = harness({ cloud: [row("cloud-thread", 1, "cloud-project")], mirrors: { "cloud-thread": "/mirrors/cloud-thread" } });
  const rows = (await listedTwice(router, windows, "threads.list", {})) as ThreadSummary[];
  expect(rows.find((each) => each.id === "cloud-thread")).toMatchObject({ worktreePath: "/mirrors/cloud-thread", owner: { brain: "cloud", mirror: true } });
  router.close();
});

it("has windows read their lists again when the brain falls asleep or comes back, so its rows dim and brighten", () => {
  const { router, windows, reach } = harness();
  reach("asleep");
  expect(windows).toEqual([{ type: "invalidate", keys: ["threads"] }]);
  router.close();
});

it("refreshes the brain's lists once more, not once per push, when they change again while a refresh runs", async () => {
  const { router, windows, asked, push } = harness({ cloud: [row("c1", 1, "cloud-project")] });
  await listedTwice(router, windows, "threads.list", {});
  const before = asked.length;
  for (let pushed = 0; pushed < 10; pushed++) push({ type: "push", push: { type: "invalidate", keys: ["threads"] } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(asked.length - before).toBe(2);
  router.close();
});

it("opens a listed cloud thread at once from the brain's last answer while it sleeps or wakes, never waking it", async () => {
  const { router, windows, link, asked } = harness({ cloud: [row("cloud-thread", 1, "cloud-project")] });
  await listedTwice(router, windows, "threads.list", {});
  link.reach = "asleep";
  const calls = asked.length;
  expect(await ask(router, "threads.get", { id: "cloud-thread" })).toMatchObject({ id: "cloud-thread", projectId: "mac-project", owner: { brain: "cloud", reach: "asleep" } });
  link.reach = "waking";
  expect(await ask(router, "threads.get", { id: "cloud-thread" })).toMatchObject({ owner: { reach: "waking" } });
  expect(asked.slice(calls)).toEqual([]);
  link.reach = "live";
  expect(await ask(router, "threads.get", { id: "cloud-thread" })).toMatchObject({ owner: { reach: "live" } });
  expect(asked.slice(calls)).toEqual(["threads.get"]);
  router.close();
});

it("marks a cloud thread this Mac is bringing here as moving, at its step, before the brain freezes its copy", async () => {
  const { router, windows, db } = harness({ cloud: [row("cloud-thread", 1, "cloud-project")] });
  relocations.open(db, { id: "move", threadId: "cloud-thread", role: "coordinator", direction: "to-mac", phase: "asking", projectId: null, step: "waking" }, 5);
  const rows = (await listedTwice(router, windows, "threads.list", {})) as ThreadSummary[];
  expect(rows.find((each) => each.id === "cloud-thread")?.moving).toEqual({ to: "mac", since: 5, step: "waking" });
  relocations.setStep(db, "move", "sending");
  expect(await ask(router, "threads.get", { id: "cloud-thread" })).toMatchObject({ moving: { to: "mac", step: "sending" } });
  relocations.advance(db, "move", "asking", "abandoned");
  expect((await ask(router, "threads.get", { id: "cloud-thread" })) as ThreadSummary).not.toHaveProperty("moving");
  router.close();
});

it("says on a cloud thread that Bring to Mac did not happen, from this Mac's own journal", async () => {
  const { router, db } = harness({ cloud: [row("cloud-thread", 1, "cloud-project")] });
  relocations.open(db, { id: "move", threadId: "cloud-thread", role: "coordinator", direction: "to-mac", phase: "asking", projectId: null }, 5);
  relocations.advance(db, "move", "asking", "abandoned", "Its branch is checked out in another folder on this Mac.", 6);
  expect(await ask(router, "threads.get", { id: "cloud-thread" })).toMatchObject({ moveRefused: { to: "mac", reason: "Its branch is checked out in another folder on this Mac.", at: 6 } });
  router.close();
});

const start = { mode: "act", permissionMode: "autonomous", agent: "claude", prompt: "Fix the build" } as const;

/** A wake that ends when the test says. */
function heldWake(): { wake: () => Promise<void>; end: (error?: Error) => void } {
  let end!: (error?: Error) => void;
  const woken = new Promise<void>((resolve, reject) => (end = (error) => (error ? reject(error) : resolve())));
  return { wake: () => woken, end };
}

const get = (router: BrainRouter, threadId: string) => ask(router, "threads.get", { id: threadId }) as Promise<ThreadSummary>;

it("answers a window's cloud start before the brain wakes, under the id the brain makes it with, until the brain's row replaces it", async () => {
  const held = heldWake();
  const answers: Answers = { cloud: [row("c1", 1, "cloud-project")], wake: held.wake };
  const { router, windows, sent } = harness(answers);
  await listedTwice(router, windows, "threads.list", {});
  const { thread } = (await ask(router, "threads.start", { ...start, projectId: "mac-project", cloud: true })) as { thread: ThreadSummary };
  const waking = { projectId: "mac-project", worktreePath: null, activity: "running", owner: { brain: "cloud", reach: "waking" }, cloud: { provider: "agent37", state: "preparing", brain: "waking" } };
  expect(thread).toMatchObject({ ...waking, title: "Fix the build", queued: [{ text: "Fix the build" }] });
  expect(sent.map((each) => each.method)).not.toContain("threads.start");
  expect(((await ask(router, "threads.list", {})) as ThreadSummary[]).find((each) => each.id === thread.id)).toMatchObject(waking);
  answers.updating = true;
  expect(await get(router, thread.id)).toMatchObject({ cloud: { brain: "updating" } });
  expect(await ask(router, "runs.listForThread", { threadId: thread.id })).toEqual([]);
  expect(await ask(router, "review.threadDiff", { threadId: thread.id, comparison: "head" })).toEqual({ baseSha: null, patch: "", files: [], since: null });

  // Sent before the brain has the thread, it waits in its queue, then follows the start there.
  const queued = (await ask(router, "threads.queue", { id: thread.id, text: "Then run the tests", requestKey: "second" })) as ThreadSummary["queued"];
  expect(queued.map((message) => message.text)).toEqual(["Fix the build", "Then run the tests"]);
  expect((await get(router, thread.id)).queued).toEqual(queued);
  held.end();
  await until(() => sent.some((each) => each.method === "threads.queue"));
  const toBrain = sent.filter((each) => each.method === "threads.start" || each.method === "threads.queue");
  expect(toBrain.map(({ method, params }) => [method, params["id"]])).toEqual([
    ["threads.start", thread.id],
    ["threads.queue", thread.id],
  ]);
  expect(toBrain[0]!.params).toMatchObject({ projectId: "cloud-project", cloud: true, prompt: "Fix the build" });
  expect(toBrain[1]!.params).toEqual({ id: thread.id, text: "Then run the tests", attachments: [], requestKey: "second" });

  await until(() => router.starts.rows(() => true).length === 0);
  const listed = ((await ask(router, "threads.list", {})) as ThreadSummary[]).filter((each) => each.id === thread.id);
  expect(listed).toEqual([expect.objectContaining({ id: thread.id, projectId: "mac-project", lastActivityAt: 99, owner: expect.objectContaining({ brain: "cloud" }) })]);
  expect(listed[0]!.cloud).toBeUndefined();
  router.close();
});

it("refuses a window's cloud start while the brain moves, waking and starting nothing", async () => {
  const answers: Answers = { cloud: [], holding: "The cloud brain is moving. Try again once it's done." };
  const { router, sent, woke } = harness(answers);
  await expect(ask(router, "threads.start", { ...start, projectId: "mac-project", cloud: true })).rejects.toThrow("The cloud brain is moving. Try again once it's done.");
  expect(router.starts.rows(() => true)).toEqual([]);
  expect([sent, woke]).toEqual([[], []]);
  answers.holding = undefined;
  await ask(router, "threads.start", { ...start, projectId: "mac-project", cloud: true });
  expect(router.starts.rows(() => true)).toHaveLength(1);
  router.close();
});

it("shows a wake that failed on the thread, in its words, and starts it anew on Try again", async () => {
  let wakes = 0;
  const answers: Answers = {
    cloud: [],
    wake: async () => {
      if (wakes++ === 0) throw new Error("The cloud brain did not start. Vercel is down.");
    },
  };
  const { router, sent } = harness(answers);
  const { thread } = (await ask(router, "threads.start", { ...start, projectId: "mac-project", cloud: true })) as { thread: ThreadSummary };
  await vi.waitFor(async () => expect(await get(router, thread.id)).toMatchObject({ cloud: { state: "failed", error: "The cloud brain did not start. Vercel is down." } }));
  await expect(ask(router, "runs.start", { threadId: thread.id, ...start })).rejects.toThrow("Vercel is down.");
  // A message queued meanwhile waits with the first for the start to go again.
  await ask(router, "threads.queue", { id: thread.id, text: "Anything?" });
  expect(sent.map((each) => each.method)).not.toContain("threads.start");

  const [first] = (await get(router, thread.id)).queued;
  await ask(router, "threads.sendQueued", { id: thread.id, messageId: first!.id });
  await until(() => sent.some((each) => each.method === "threads.queue"));
  expect(sent.filter((each) => each.method === "threads.start" || each.method === "threads.queue").map(({ method, params }) => [method, params["id"]])).toEqual([
    ["threads.start", thread.id],
    ["threads.queue", thread.id],
  ]);
  expect(wakes).toBe(2);
  router.close();
});

it("starts a thread here unless it asks for the cloud, and refuses the cloud for a project the brain has no copy of", async () => {
  const { router, asked } = harness();
  await expect(ask(router, "threads.start", { ...start, projectId: "other-project", cloud: true })).rejects.toThrow(NOT_ON_BRAIN);
  await ask(router, "threads.start", { ...start, projectId: "mac-project", workspaceMode: "worktree" });
  expect(asked).not.toContain("threads.start");
  router.close();
});

it("stores a window's attached files on the brain before the call naming them, images as images, none over the link's limit", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-router-images-"));
  try {
    const image = path.join(folder, "shot.png");
    await writeFile(image, "png bytes");
    const notes = path.join(folder, "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55-notes.pdf");
    await writeFile(notes, "pdf bytes");
    const { router, sent } = harness({ cloud: [row("cloud-thread", 1, "cloud-project")] });
    await ask(router, "threads.queue", { id: "cloud-thread", text: "See these", attachments: [image, notes] });
    expect(sent.map((each) => each.method)).toEqual(["attachments.save", "attachments.saveFile", "threads.queue"]);
    expect(sent[0]!.params).toEqual({ name: "shot.png", mime: "image/png", dataBase64: Buffer.from("png bytes").toString("base64") });
    expect(sent[1]!.params).toEqual({ name: "notes.pdf", dataBase64: Buffer.from("pdf bytes").toString("base64") });
    expect(sent[2]!.params["attachments"]).toEqual(["/brain/attachments/1.png", "/brain/attachments/2-notes.pdf"]);
    const large = path.join(folder, "large.log");
    await writeFile(large, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(ask(router, "threads.queue", { id: "cloud-thread", text: "Read this", attachments: [large] })).rejects.toThrow("must be 10 MB or smaller");
    expect(sent).toHaveLength(3);
    router.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("lists the brain's tasks beside this Mac's, on this Mac's project and marked as the cloud's, and sends a cloud task's calls to the brain", async () => {
  const task = (taskId: string, projectId: string, updatedAt: number) => ({ id: taskId, projectId, title: taskId, status: "backlog", updatedAt, worktreePath: null }) as unknown as Task;
  const asked: { method: RpcMethod; params: Record<string, unknown> }[] = [];
  const windows: CorePush[] = [];
  const db = Db.memory();
  const project = projects.insert(db, { name: "App", rootPath: "/app", gitRemote: null, defaultBranch: null, settings: {} });
  const local = tasks.insert(db, { projectId: project.id, title: "Here", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  const link = {
    reach: "live",
    onPush: () => {},
    onReach: () => {},
    setInterest: () => {},
    call: async (method: RpcMethod, params: Record<string, unknown>) => {
      asked.push({ method, params });
      if (method === "tasks.list") return [task("cloud-task", "cloud-project", 5)];
      return task(String(params["id"]), "cloud-project", 5);
    },
  };
  const router = new BrainRouter({
    db,
    link: link as unknown as BrainLink,
    wake: async () => undefined,
    updating: () => false,
    service: async () => "vercel",
    mirrors: { folder: () => null, isOpen: () => false, pull: async () => {} },
    local: async (request) => ({ type: "rpc.result", id: request.id, result: request.method === "tasks.list" ? [task("mac-task", "mac-project", 3)] : "here" }),
    windows: { push: (push) => void windows.push(push) },
    mapping: async () => ({ toCloud: (each) => (each === "mac-project" ? "cloud-project" : null), toMac: (each) => (each === "cloud-project" ? "mac-project" : null) }),
    notificationsOn: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
  });
  await ask(router, "tasks.list", { projectId: "mac-project" });
  await until(() => windows.some((push) => push.type === "invalidate" && push.keys.includes("tasks")));
  const listed = (await ask(router, "tasks.list", { projectId: "mac-project" })) as Task[];
  expect(listed.map((each) => [each.id, each.projectId, each.owner?.brain ?? "mac"])).toEqual([
    ["cloud-task", "mac-project", "cloud"],
    ["mac-task", "mac-project", "mac"],
  ]);
  expect(asked[0]).toEqual({ method: "tasks.list", params: { projectId: "cloud-project" } });
  expect(await ask(router, "tasks.get", { id: "cloud-task" })).toMatchObject({ id: "cloud-task", projectId: "mac-project", owner: { brain: "cloud" } });
  expect(await ask(router, "tasks.get", { id: local.id })).toBe("here");
  expect(asked.map((each) => each.method)).toEqual(["tasks.list", "tasks.list", "tasks.get"]);
  router.close();
});

it("never wakes the brain for a window reading again what it shows, and answers from what the window holds", async () => {
  const { router, windows, link, woke, asked } = harness({ cloud: [row("cloud-thread", 1, "cloud-project")] });
  await listedTwice(router, windows, "threads.list", {});
  link.reach = "asleep";
  const calls = asked.length;
  // The Commits panel's and task comments' polls, and the open pane's reads again after a change on this Mac.
  for (const [method, params] of [
    ["git.threadPushState", { threadId: "cloud-thread" }],
    ["git.threadLog", { threadId: "cloud-thread" }],
    ["threads.messages", { id: "cloud-thread" }],
    ["runs.listForThread", { threadId: "cloud-thread" }],
    ["events.page", { runId: "cloud-run" }],
  ] as const)
    await expect(ask(router, method, params, true)).rejects.toThrow(new BrainOutOfReach("asleep").message);
  expect(woke).toEqual([]);
  expect(asked.slice(calls)).toEqual([]);
  // The person opening the conversation does wake it.
  link.reach = "live";
  await ask(router, "threads.messages", { id: "cloud-thread" });
  expect(woke).toEqual(["threads.messages"]);
  router.close();
});

it("answers a call about a thread, run or task on neither host here, never waking the brain for it", async () => {
  const { router, windows, link, woke } = harness({ mac: [row("mac-thread", 2, "mac-project")], cloud: [row("cloud-thread", 1, "cloud-project")] });
  await listedTwice(router, windows, "threads.list", {});
  link.reach = "asleep";
  // A Mac thread just deleted, whose open pane reads it once more, or a task this Mac never had: this Mac's own answer.
  for (const [method, params] of [
    ["threads.get", { id: "deleted-thread" }],
    ["runs.listForThread", { threadId: "deleted-thread" }],
    ["tasks.comments.list", { taskId: "deleted-task" }],
  ] as const)
    expect({ method, result: await ask(router, method, params) }).toEqual({ method, result: [row("mac-thread", 2, "mac-project")] });
  await expect(ask(router, "events.page", { runId: "deleted-run" })).rejects.toThrow(new BrainOutOfReach("asleep").message);
  expect(woke).toEqual([]);
  // A thread the brain lists wakes it as a person opens it.
  await ask(router, "threads.messages", { id: "cloud-thread" });
  expect(woke).toEqual(["threads.messages"]);
  router.close();
});

it("settles a cloud start's Claude account on this Mac when its project uses only some, and sends any other start as it came", async () => {
  const { router, db, sent } = harness({ cloud: [] });
  const [work, personal] = ["Work", "Personal"].map((name) => claudeAccounts.add(db, name).id) as [string, string];
  db.stmt("INSERT INTO projects (id, name, root_path, git_remote, default_branch, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)").run(
    "mac-project",
    "Mac project",
    "/tmp/mac-project",
    null,
    "main",
    JSON.stringify({ setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [], claudeAccounts: null }),
  );
  const startCloud = async (claudeAccountId?: string) => {
    const { thread } = (await ask(router, "threads.start", { ...start, projectId: "mac-project", cloud: true, ...(claudeAccountId ? { claudeAccountId } : {}) })) as { thread: ThreadSummary };
    await until(() => sent.some((each) => each.method === "threads.start" && each.params["id"] === thread.id));
    return { thread, sent: sent.find((each) => each.method === "threads.start" && each.params["id"] === thread.id)!.params };
  };

  // Following the app's accounts, the brain picks as it always has.
  expect((await startCloud()).sent).not.toHaveProperty("claudeAccountId");
  projects.updateSettings(db, "mac-project", { claudeAccounts: { only: true, accountIds: [work, personal], defaultId: personal, autoSwitch: true } });
  const onDefault = await startCloud();
  expect([onDefault.thread.claudeAccountId, onDefault.sent["claudeAccountId"]]).toEqual([personal, personal]);
  expect((await startCloud(work)).sent["claudeAccountId"]).toBe(work);
  await expect(ask(router, "threads.start", { ...start, projectId: "mac-project", cloud: true, claudeAccountId: "claude-cli" })).rejects.toThrow(/This project only uses these Claude accounts/);
  router.close();
});

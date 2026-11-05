import { afterEach, expect, it, vi } from "vitest";
import { Db, relocations } from "@openorc/db";
import { threadListCompare, type CorePush, type InboxList, type OwnerReach, type RpcMethod, type RpcRequest, type ThreadSummary } from "@openorc/protocol";
import type { RpcReply } from "../transport.js";
import { until } from "../test-fixtures/fake-claude.js";
import type { BrainLink, BrainPush } from "./brain-link.js";
import { BrainRouter } from "./brain-router.js";

const row = (id: string, lastActivityAt: number, projectId: string, worktreePath: string | null = null) =>
  ({ id, projectId, worktreePath, pinnedAt: null, archivedAt: null, doneAt: null, lastActivityAt, parentThreadId: null }) as unknown as ThreadSummary;

/** A host's answer to a page of the thread list, as its ledger pages it. */
function paged(rows: ThreadSummary[], params: { limit?: number; offset?: number }): ThreadSummary[] {
  const sorted = [...rows].sort(threadListCompare());
  const offset = params.offset ?? 0;
  return sorted.slice(offset, params.limit ? offset + params.limit : undefined);
}

function harness(answers: { mac?: ThreadSummary[]; cloud?: ThreadSummary[]; cloudInbox?: InboxList; mirrors?: Record<string, string> } = {}) {
  const interest: string[][] = [];
  const windows: CorePush[] = [];
  const reaches: ((reach: OwnerReach) => void)[] = [];
  const pushes: ((push: BrainPush) => void)[] = [];
  const asked: RpcMethod[] = [];
  const link = {
    reach: "live",
    onPush: (listener: (push: BrainPush) => void) => void pushes.push(listener),
    onReach: (listener: (reach: OwnerReach) => void) => void reaches.push(listener),
    setInterest: (runIds: readonly string[]) => void interest.push([...runIds]),
    call: async (method: RpcMethod, params: Record<string, unknown>) => {
      asked.push(method);
      if (method === "threads.list") return paged(answers.cloud ?? [], params);
      if (method === "inbox.list") return answers.cloudInbox ?? { items: [] };
      if (method === "threads.get") return (answers.cloud ?? []).find((each) => each.id === params["id"]) ?? null;
      return { events: [], fromTurn: 0, live: false };
    },
  };
  const db = Db.memory();
  const router = new BrainRouter({
    db,
    link: link as unknown as BrainLink,
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
    reach: (next: OwnerReach) => reaches.forEach((listener) => listener(next)),
    push: (push: BrainPush) => pushes.forEach((listener) => listener(push)),
  };
}

let id = 0;
async function ask(router: BrainRouter, method: RpcMethod, params: unknown): Promise<unknown> {
  const reply: RpcReply = await router.handle({ type: "rpc", id: ++id, method, params } as RpcRequest);
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

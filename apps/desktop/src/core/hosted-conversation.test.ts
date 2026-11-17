import { createClientState, conversationActivity, sendCluster, tagsFor, type ClientPush, type ClientState, type CoreConnection } from "@openorc/client";
import { OpenOrc } from "@openorc/core";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { hostedRunId, type RpcMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import { QueryObserver } from "@tanstack/react-query";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const EMAIL = "reader@example.com";
let stand: StandIn;
let core: OpenOrc;
let client: ClientState;
let connection: CoreConnection;
let folder: string;
let stored: string | null;
const releases: (() => void)[] = [];
/** What each test made, closed last first: only what its setup got to, should the setup not finish. */
const closers: (() => unknown)[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  closers.push(() => stand.close());
  stand.setBilling(EMAIL, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(EMAIL, [{ agent: "claude" }]);
  folder = await mkdtemp(path.join(tmpdir(), "hosted-conversation-"));
  closers.push(() => rm(folder, { recursive: true, force: true }));
  const listeners = new Set<(push: ClientPush) => void>();
  let nextId = 0;
  connection = {
    delivery: "all",
    async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
      const reply = await core.handle({ type: "rpc", id: ++nextId, method, params });
      if (reply.type === "rpc.error") throw new Error(reply.message);
      return reply.result as RpcResults[M];
    },
    onPush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFrameInterest: () => undefined,
  };
  client = createClientState(connection, {
    scheduleFrame: (flush) => queueMicrotask(flush),
    invalidationBatchMs: 5,
    randomId: () => crypto.randomUUID(),
    savesDefaultPermission: false,
    reportFrameError: (_frame, error) => {
      throw error;
    },
  });
  closers.push(() => {
    client.queryClient.clear();
    client.runs.reset();
  });
  stored = null;
  core = await OpenOrc.create({
    dataDir: folder,
    // No login shell to wait for: this process's environment, and the ledger in memory.
    ephemeral: true,
    accountServer: stand.url,
    accountSecrets: {
      load: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    openBrowser: (url) => {
      if (new URL(url).pathname === "/sign-in") void fetch(stand.signInPage(url, EMAIL));
    },
    transport: {
      push: (push) => {
        if (push.type === "frame" || push.type === "invalidate" || push.type === "gap") listeners.forEach((listener) => listener(push));
      },
    },
  });
  closers.push(() => core.close());
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const close of closers.splice(0).reverse()) await close();
});

function watch<M extends RpcMethod>(method: M, params: RpcParams<M>) {
  const observer = new QueryObserver(client.queryClient, {
    queryKey: [method, params],
    meta: { tags: tagsFor(method, params) },
    queryFn: () => connection.call(method, params),
  });
  releases.push(observer.subscribe(() => undefined));
  return () => observer.getCurrentResult().data;
}

async function openThread(threadId: string) {
  await connection.call("account.signIn", {});
  await vi.waitFor(async () => expect(await connection.call("threads.get", { id: threadId })).not.toBeNull(), { timeout: 5_000 });
  const thread = watch("threads.get", { id: threadId });
  const runs = watch("runs.listForThread", { threadId });
  const runId = hostedRunId(threadId);
  releases.push(client.runs.retain([runId]));
  await vi.waitFor(() => expect(runs()).toBeDefined());
  // The conversation loads each run once and keeps receiving its frames and snapshot changes while open.
  await client.runs.hydrate(runId, { turns: 4 });
  return {
    runId,
    thread,
    runs,
    activity: () => conversationActivity({ thread: thread() ?? null, activeRun: runs()?.at(-1), liveTranscript: client.runs.get(runId), compacting: false }),
  };
}

it.each(["parked answer", "first send", "another device"] as const)(
  "shows Stop as soon as the row starts working after %s, before a session event",
  async (way) => {
    const threadId = stand.addThread(EMAIL, { projectId: null, title: "Check the report", status: way === "parked answer" ? "working" : "idle" });
    let ask: string | undefined;
    if (way === "parked answer") {
      ask = stand.ask(threadId, { kind: "command", toolName: "Bash", input: { command: "pnpm build" }, detail: "Run the build" });
      stand.endTurn(threadId);
    } else if (way === "another device") {
      stand.append(threadId, [{ type: "message.completed", ts: 1, messageId: "previous", role: "assistant", text: "The report is ready." }]);
      stand.endTurn(threadId);
    }
    const shown = await openThread(threadId);
    expect(shown.activity()).toMatchObject({ live: false, working: false });
    if (way === "parked answer") {
      await connection.call("approvals.resolve", { runId: shown.runId, approvalId: ask!, decision: "allow" });
    } else if (way === "another device") {
      // Write straight to the server. This window must learn of the turn through its socket alone.
      const session: unknown = JSON.parse(stored ?? "{}");
      if (!session || typeof session !== "object" || !("token" in session) || typeof session.token !== "string") throw new Error("The test sign-in did not save a token");
      const response = await fetch(`${stand.url}/hosted/threads/${threadId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: crypto.randomUUID(), text: "Check the totals" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sent: true });
    } else {
      await connection.call("runs.start", { threadId, agent: "claude", mode: "act", permissionMode: "trusted", prompt: "Check the totals" });
    }
    await vi.waitFor(() => expect(shown.thread()?.activity).toBe("running"));
    await vi.waitFor(() => expect(shown.runs()?.at(-1)?.endedAt).toBeNull());
    await vi.waitFor(() => expect(client.runs.get(shown.runId)?.live).toBe(true));
    const activity = shown.activity();
    expect(sendCluster({ queueing: activity.working, liveByDefault: true, steerable: activity.live, canStop: activity.live && activity.working, hasDraft: false })).toEqual({ kind: "stop" });
    await connection.call("runs.interrupt", { runId: shown.runId });
    await vi.waitFor(() => expect(shown.activity()).toMatchObject({ live: false, working: false }));
    await vi.waitFor(() => expect(client.runs.get(shown.runId)?.live).toBe(false));
    expect(stand.requests.some((request) => request.path === `/hosted/threads/${threadId}/stop`)).toBe(true);
  },
  15_000,
);

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLOUD_THREAD_WRITES, hostedRunId, ownerRoute, REMOTE_METHODS, type RemotePush } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { requestOrigin } from "../request-origin.js";
import type { Broadcast } from "../transport.js";
import { CLOUD, cloudMac, MARA, ME, paid, TODAY, type CloudMac } from "./test-fixtures/cloud-mac.js";
import { RemoteTestClient } from "./test-client.js";

/*
 * A phone whose session shares `cloud-threads` reads the spaces and OpenOrc Cloud threads of the person signed in on
 * the Mac it is paired with. It is served what that person's own window is served, and nothing else: every case here
 * is either that, or a refusal.
 */

const FROM_PHONE = "This is not available from a phone.";
const GONE = "That conversation isn't available on OpenOrc Cloud.";
const frozen = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." } as const;

let at: CloudMac;
/** Never asked for anything, asks for what today's phone does, and asks for cloud threads too. */
let legacy: RemoteTestClient;
let today: RemoteTestClient;
let capable: RemoteTestClient;

beforeAll(async () => {
  at = await cloudMac();
  legacy = await at.phone(null);
  today = await at.phone(TODAY);
  capable = await at.phone(CLOUD);
}, 30_000);
afterAll(() => at.close());

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);
const frames = (pushes: readonly (RemotePush | Broadcast)[], runId: string) => pushes.flatMap((push) => (push.type === "frame" && push.frame.runId === runId ? push.frame.events : []));
const said = (pushes: readonly (RemotePush | Broadcast)[], runId: string, messageId: string) =>
  frames(pushes, runId).some((event) => event.type === "message.completed" && event.messageId === messageId);
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Error) => error.message,
  );
/** One line of the agent in a cloud thread, as the server sends it to everyone watching. */
const speak = (threadId: string, messageId: string) => at.stand.append(threadId, [{ type: "message.completed", ts: Date.now(), messageId, role: "assistant", text: `Line ${messageId}` }]);
/** A round trip the Mac answers after everything it had queued for the phone. */
const settled = (phone: RemoteTestClient) => phone.call("projects.list", {});

it("shares cloud threads with a session that asks, and with no other", async () => {
  const asked = await at.phone(null);
  await expect(asked.request("session.negotiate", { capabilities: CLOUD })).resolves.toEqual({ capabilities: CLOUD });
  await expect(asked.request("session.negotiate", { capabilities: TODAY })).resolves.toEqual({ capabilities: TODAY });
  // Asked again without it, the session is an ordinary one again.
  await expect(asked.request("spaces.status", {})).rejects.toThrow(FROM_PHONE);
});

describe.each([
  ["that never asked for anything", () => legacy],
  ["that asked for what today's phone asks", () => today],
])("a session %s", (_name, session) => {
  it("is served this Mac alone, as before", async () => {
    for (const method of ["spaces.status", "spaces.projects", "threads.collaboration", "threads.authors"])
      await expect(session().request(method, { spaceId: at.cloud.birch, threadId: at.cloud.threads.teammate })).rejects.toThrow(FROM_PHONE);
    expect(ids(await session().call("threads.list", { spaceId: at.cloud.birch }))).toEqual([at.mac.threadId]);
    expect(await session().call("threads.get", { id: at.cloud.threads.teammate })).toBeNull();
    expect(await session().call("events.page", { runId: hostedRunId(at.cloud.threads.teammate) })).toMatchObject({ events: [] });
  });
});

describe("a session that shares cloud threads", () => {
  it("reads the person's spaces with nothing of the server's address or anyone's mail", async () => {
    const status = await capable.call("spaces.status", {});
    expect(status).toMatchObject({ state: "ready", personalSpaceId: `personal-${ME}`, invitations: [], create: { allowed: false }, apiOrigin: "" });
    if (status.state !== "ready") throw new Error("not ready");
    expect(status.spaces.map((space) => (space.kind === "organization" ? space.name : "Personal")).sort()).toEqual(["Alder Works", "Birch Studio", "Personal"]);
    const window = await at.window("spaces.status", {});
    expect(status.spaces).toEqual(window.state === "ready" ? window.spaces : null);
    expect(JSON.stringify(status)).not.toContain(at.stand.url);
    expect(JSON.stringify(status)).not.toContain(MARA);
  });

  it("reads a space's projects, one the Mac has a folder for and the server's own", async () => {
    expect(await capable.call("spaces.projects", { spaceId: at.cloud.birch })).toEqual(await at.window("spaces.projects", { spaceId: at.cloud.birch }));
    expect(await capable.call("spaces.projects", { spaceId: at.cloud.birch })).toMatchObject([{ name: "Canvas", localProjectId: at.mac.projectId, hostedProjectId: at.cloud.projects.birch }]);
  });

  it("lists a space as the person's window lists it, and this Mac alone when it names no space", async () => {
    for (const spaceId of [at.cloud.birch, at.cloud.alder, `personal-${ME}`]) {
      const rows = await capable.call("threads.list", { spaceId });
      expect(ids(rows)).toEqual(ids(await at.window("threads.list", { spaceId })));
      expect(await capable.call("threads.resolvedCount", { spaceId, projectIds: [at.mac.projectId], quietBefore: Date.now() + 1 })).toBe(
        await at.window("threads.resolvedCount", { spaceId, projectIds: [at.mac.projectId], quietBefore: Date.now() + 1 }),
      );
    }
    const birch = await capable.call("threads.list", { spaceId: at.cloud.birch });
    expect(ids(birch)).toEqual(expect.arrayContaining([at.cloud.threads.teammate, at.mac.threadId]));
    expect(birch.find((row) => row.id === at.cloud.threads.teammate)).toMatchObject({ title: "Birch pricing page", owner: { brain: "hosted", startedBy: { name: "Mara Okafor" } } });
    expect(ids(await capable.call("threads.list", {}))).toEqual([at.mac.threadId]);
    expect(ids(await capable.call("threads.list", { projectIds: [at.mac.projectId, ...Object.values(at.cloud.projects)] }))).toEqual([at.mac.threadId]);
    expect((await capable.call("inbox.list", {})).items.every((item) => item.kind !== "thread" || item.thread.id === at.mac.threadId)).toBe(true);
  });

  it("opens a cloud thread: its row, its run, its log, who is in it and who wrote what", async () => {
    const threadId = at.cloud.threads.teammate;
    const runId = hostedRunId(threadId);
    speak(threadId, "opened");
    expect(await capable.call("threads.get", { id: threadId })).toMatchObject({ id: threadId, title: "Birch pricing page", owner: { brain: "hosted" } });
    await vi.waitFor(async () => expect((await capable.call("events.page", { runId })).events).toContainEqual(expect.objectContaining({ type: "message.completed", messageId: "opened" })));
    // The run is read off the thread's row, which this Mac hears of a moment after the log.
    await vi.waitFor(async () => expect(ids(await capable.call("runs.listForThread", { threadId }))).toEqual([runId]));
    expect(await capable.call("runs.listForThread", { threadId })).toEqual(await at.window("runs.listForThread", { threadId }));
    expect(await capable.call("threads.lastMessage", { id: threadId })).toEqual(await at.window("threads.lastMessage", { id: threadId }));
    expect(await capable.request("threads.collaboration", { threadId })).toEqual(await at.window("threads.collaboration", { threadId }));
    expect(await capable.request("threads.authors", { threadId })).toEqual(await at.window("threads.authors", { threadId }));
    // A tool call's whole output, as the window opens it.
    at.stand.threadFiles.capabilities = { toolOutput: { available: true } };
    at.stand.append(threadId, [{ type: "tool.completed", ts: Date.now(), toolCallId: "tool-whole", output: "line of output\n".repeat(2_000) }]);
    const whole = await at.window("events.toolOutput", { runId, toolCallId: "tool-whole" });
    expect(whole).toEqual({ output: "line of output\n".repeat(2_000) });
    expect(await capable.call("events.toolOutput", { runId, toolCallId: "tool-whole" })).toEqual(whole);
  });

  it("keeps its phone's name on a request that goes on to this Mac", async () => {
    const origins: unknown[] = [];
    const get = at.core.threads.get.bind(at.core.threads);
    const spy = vi.spyOn(at.core.threads, "get").mockImplementation((id) => {
      origins.push(requestOrigin.getStore());
      return get(id);
    });
    try {
      expect(await capable.call("threads.get", { id: at.mac.threadId })).toMatchObject({ title: "Mac retry fix" });
      await capable.call("threads.list", { spaceId: at.cloud.birch });
    } finally {
      spy.mockRestore();
    }
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every((origin) => (origin as { kind?: string; deviceId?: string } | undefined)?.deviceId === capable.deviceId)).toBe(true);
  });

  it("hears a cloud thread it asked for, beside a window, while the phones without the capability hear nothing of it", async () => {
    const threadId = at.cloud.threads.teammate;
    const runId = hostedRunId(threadId);
    const idle = await at.phone(CLOUD);
    for (const phone of [legacy, today, capable]) phone.interest([at.mac.runId, runId]);
    idle.interest([at.mac.runId]);
    // The phone's own read of the log is what makes this Mac follow the thread: no window has opened it.
    await capable.call("events.page", { runId });
    speak(threadId, "streamed");
    await vi.waitFor(() => expect(said(capable.pushes, runId, "streamed")).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(said(at.windowPushes, runId, "streamed")).toBe(true), { timeout: 5_000 });
    for (const phone of [legacy, today, idle]) {
      await settled(phone);
      expect(frames(phone.pushes, runId)).toEqual([]);
    }
    for (const phone of [legacy, today]) expect(JSON.stringify(phone.pushes)).not.toContain(threadId);
    // What changed in the thread is told to the phone that shares cloud threads, by the keys its lists are read under.
    expect(capable.pushes.some((push) => push.type === "invalidate" && push.keys.includes(`runs:thread:${threadId}`))).toBe(true);
  });

  it("is told nothing of the account but its threads, spaces and projects changing", async () => {
    at.stand.setBilling(ME, paid());
    await at.window("spaces.refresh", {});
    await settled(capable);
    const keys = capable.pushes.flatMap((push) => (push.type === "invalidate" ? push.keys : []));
    expect(keys.filter((key) => /^(account|people|invitations|repositories|organization-billing|online-tasks|hostedFiles|hostedAssets)/.test(key))).toEqual([]);
    expect(capable.pushes.filter((push) => push.type === "notify" && push.threadId !== at.mac.threadId)).toEqual([]);
  });

  it("is refused every change a phone may not make to a cloud thread, and a Stop or an answer that names nothing it saw", async () => {
    const before = { sent: at.stand.sent.length, answered: at.stand.answered.length, started: at.stand.started.length, readies: at.stand.readies.length };
    const requests = at.stand.requests.length;
    const threadId = at.cloud.threads.teammate;
    const runId = hostedRunId(threadId);
    const ask = at.stand.ask(threadId, { kind: "command", toolName: "Bash", input: { command: "pnpm build" }, detail: "Run the build" });
    const changes: [string, unknown][] = [
      ["runs.interrupt", { runId }],
      ["approvals.resolve", { runId, approvalId: ask, decision: "allow" }],
      ["threads.sendQueued", { id: threadId, messageId: "message" }],
    ];
    for (const [method, params] of changes) expect([method, await refusal(capable.request(method, params))]).toEqual([method, FROM_PHONE]);
    // Every other call a phone may make about one thread or run that is no read and no allowed change: refused for a
    // cloud thread, never passed to this Mac (whose answer would be "not found") and never to the server.
    const reads = new Set(["threads.get", "runs.listForThread", "events.page", "threads.messages", "threads.lastMessage"]);
    const allowed = new Set<string>([...CLOUD_THREAD_WRITES, ...changes.map(([method]) => method)]);
    const aboutOne = REMOTE_METHODS.filter((each) => ["owner", "run", "here"].includes(ownerRoute(each)?.by ?? "") && !reads.has(each) && !allowed.has(each));
    expect(aboutOne.length).toBeGreaterThan(10);
    for (const method of aboutOne) {
      const answer = await refusal(capable.request(method, { threadId, id: threadId, runId }));
      expect([method, answer]).toEqual([method, expect.stringMatching(/^(This is not available from a phone\.$|invalid params for )/)]);
    }
    expect({ sent: at.stand.sent.length, answered: at.stand.answered.length, started: at.stand.started.length, readies: at.stand.readies.length }).toEqual(before);
    expect(at.stand.requests.slice(requests).filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("is refused a space and a thread the person cannot read, never answered from this Mac", async () => {
    expect(await refusal(capable.call("spaces.projects", { spaceId: at.cloud.cedar }))).toEqual(await refusal(at.window("spaces.projects", { spaceId: at.cloud.cedar })));
    expect(await refusal(capable.call("spaces.projects", { spaceId: at.cloud.cedar }))).not.toBeNull();
    expect(await refusal(capable.call("threads.list", { spaceId: at.cloud.cedar }))).not.toBeNull();
    expect(await refusal(capable.call("threads.resolvedCount", { spaceId: at.cloud.cedar, projectIds: [at.mac.projectId], quietBefore: Date.now() }))).not.toBeNull();
    const threadId = at.cloud.threads.cedar;
    expect(await capable.call("threads.get", { id: threadId })).toBeNull();
    expect(await refusal(capable.call("events.page", { runId: hostedRunId(threadId) }))).toBe(GONE);
    // An id this Mac never heard of is no cloud thread to it: it says so, and nothing more.
    expect(await capable.request("threads.collaboration", { threadId })).toEqual({ supported: false });
    expect(await refusal(capable.request("threads.authors", { threadId }))).not.toBeNull();
    capable.interest([hostedRunId(threadId)]);
    speak(threadId, "cedar");
    await settled(capable);
    const heard = JSON.stringify(capable.received.filter((message) => message.t !== "rpc.error"));
    expect(["Cedar Lab", "Cedar roadmap", at.cloud.cedar, at.cloud.projects.cedar, threadId].filter((word) => heard.includes(word))).toEqual([]);
  });

  it("loses a project's thread the moment the person's access to it is taken away, mid-stream", async () => {
    const threadId = at.cloud.threads.teammate;
    const runId = hostedRunId(threadId);
    capable.interest([runId]);
    await capable.call("events.page", { runId });
    speak(threadId, "before");
    await vi.waitFor(() => expect(said(capable.pushes, runId, "before")).toBe(true), { timeout: 5_000 });

    await at.asMara((mara) => mara("organization.project.setAccess", { spaceId: at.cloud.birch, projectId: at.cloud.projects.birch, everyone: false, memberIds: [] }));
    await vi.waitFor(async () => expect(await at.window("spaces.projects", { spaceId: at.cloud.birch })).toEqual([]), { timeout: 5_000 });
    speak(threadId, "after");
    await settled(capable);
    expect(said(capable.pushes, runId, "after")).toBe(false);
    expect(await refusal(capable.call("events.page", { runId }))).toBe(GONE);
    expect(await refusal(capable.call("threads.get", { id: threadId }))).toBe(GONE);
    expect(await refusal(capable.request("threads.collaboration", { threadId }))).toBe(GONE);
    expect(ids(await capable.call("threads.list", { spaceId: at.cloud.birch }))).not.toContain(threadId);
    expect(await capable.call("spaces.projects", { spaceId: at.cloud.birch })).toEqual([]);
    // The person's own organization is untouched.
    expect(ids(await capable.call("threads.list", { spaceId: at.cloud.alder }))).toContain(at.cloud.threads.mine);

    await at.asMara((mara) => mara("organization.project.setAccess", { spaceId: at.cloud.birch, projectId: at.cloud.projects.birch, everyone: true, memberIds: [] }));
    await vi.waitFor(async () => expect(ids(await capable.call("threads.list", { spaceId: at.cloud.birch }))).toContain(threadId), { timeout: 5_000 });
  });

  it("loses every organization's threads while the person is frozen, is told so in the server's words, and keeps Personal and this Mac", async () => {
    const mine = at.cloud.threads.mine;
    const runId = hostedRunId(mine);
    capable.interest([runId]);
    await capable.call("events.page", { runId });
    at.stand.setBilling(ME, { pro: false, organizationAccess: frozen });
    await at.window("spaces.refresh", {});
    try {
      await vi.waitFor(async () => expect(await at.window("threads.get", { id: mine }).catch(() => null)).toBeNull(), { timeout: 5_000 });
      expect(await capable.call("spaces.status", {})).toMatchObject({ state: "ready", organizationAccess: { state: "frozen", message: frozen.message } });
      // As for the person's window, an organization lists nothing while frozen: the state above is what says why.
      for (const spaceId of [at.cloud.alder, at.cloud.birch]) {
        expect(await capable.call("threads.list", { spaceId })).toEqual([]);
        expect(await at.window("threads.list", { spaceId })).toEqual([]);
        expect(await capable.call("spaces.projects", { spaceId })).toEqual([]);
      }
      expect(await refusal(capable.call("events.page", { runId }))).toBe(GONE);
      expect(await refusal(capable.call("threads.get", { id: mine }))).toBe(GONE);
      speak(mine, "frozen");
      await settled(capable);
      expect(said(capable.pushes, runId, "frozen")).toBe(false);
      expect(ids(await capable.call("threads.list", { spaceId: `personal-${ME}` }))).toEqual(ids(await at.window("threads.list", { spaceId: `personal-${ME}` })));
      expect(ids(await capable.call("threads.list", {}))).toEqual([at.mac.threadId]);
    } finally {
      at.stand.setBilling(ME, paid());
      await at.window("spaces.refresh", {});
    }
    await vi.waitFor(async () => expect(ids(await capable.call("threads.list", { spaceId: at.cloud.alder }))).toContain(mine), { timeout: 5_000 });
  });

  // The last case of this Mac: it signs the person out.
  it("is told the person signed out, and is refused their spaces and threads from then on", async () => {
    const threadId = at.cloud.threads.teammate;
    const runId = hostedRunId(threadId);
    capable.interest([runId]);
    await capable.call("events.page", { runId });
    await at.window("account.signOut", {});
    await vi.waitFor(async () => expect(await capable.call("spaces.status", {})).toEqual({ state: "signed-out" }), { timeout: 5_000 });
    expect(await refusal(capable.call("spaces.projects", { spaceId: at.cloud.birch }))).not.toBeNull();
    expect(await refusal(capable.call("threads.list", { spaceId: at.cloud.birch }))).not.toBeNull();
    expect(await refusal(capable.call("events.page", { runId }))).toBe(GONE);
    expect(await refusal(capable.call("threads.get", { id: threadId }))).toBe(GONE);
    speak(threadId, "signed-out");
    await settled(capable);
    expect(said(capable.pushes, runId, "signed-out")).toBe(false);
    expect(ids(await capable.call("threads.list", {}))).toEqual([at.mac.threadId]);
  });
});

it("says an account is not available on a Mac that has none, and still serves that Mac", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-phone-none-"));
  let secret: string | null = null;
  const core = await OpenOrc.create({
    dataDir: folder,
    ephemeral: true,
    transport: { push() {} },
    remoteSecrets: { load: async () => secret, save: async (value) => void (secret = value) },
    remoteNetwork: { port: 0, machine: { name: () => "QA", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] } },
  });
  try {
    await core.remote.attach((request, origin) => core.handle(request, origin));
    await core.remote.configure(true);
    const phone = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
    if (typeof phone === "string") throw new Error(phone);
    await expect(phone.request("session.negotiate", { capabilities: CLOUD })).resolves.toEqual({ capabilities: CLOUD });
    expect(await phone.call("spaces.status", {})).toEqual({ state: "unavailable" });
    expect(await refusal(phone.call("spaces.projects", { spaceId: "personal" }))).not.toBeNull();
    expect(await refusal(phone.call("threads.list", { spaceId: "personal" }))).toBe("OpenOrc accounts aren't available here.");
    expect(await phone.call("threads.list", {})).toEqual([]);
    phone.close();
  } finally {
    await core.close();
    await rm(folder, { recursive: true, force: true });
  }
});

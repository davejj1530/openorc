import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { projects, runs, tasks, threads } from "@openorc/db";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { linkUrl, toBase64Url } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { installedMacMessage, rawMacHello } from "@openorc/link/test-fixtures/installed-phone";
import { AgentEvent, hostedRunId, isRemoteMethod, rpcParams, type RemotePush } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import type { Broadcast } from "../transport.js";
import { everyEvent, INSTALLED_BUILDS, type InstalledBuild } from "./test-fixtures/installed-phone-builds.js";
import { installedTaskEvents, installedTaskIdFromTool } from "./test-fixtures/installed-task-phone.js";
import { RemoteTestClient } from "./test-client.js";
import { linkSocket } from "./ws-socket.js";

/*
 * A Mac signed in to an OpenOrc account, with organizations and cloud threads, as every phone build already installed
 * meets it. The phones are attached the way the app attaches them, each request naming its origin, so what is proved
 * here is the route a real phone takes. None of these builds knows of accounts: it must be served this Mac's own work,
 * in the shapes it reads, and nothing of the account.
 */

const ME = "reader@example.com";
const MARA = "mara@example.com";
const REPOSITORY = "example/canvas";
const FROM_PHONE = "not available from a phone";

let stand: StandIn;
let core: OpenOrc;
let folder: string;
const windowPushes: Broadcast[] = [];
const window = rpcClient(() => core);
const phones: RemoteTestClient[] = [];

/** What the account holds and this Mac does not. */
let cloud: { birch: string; alder: string; projects: string[]; threads: { personal: string; teammate: string; mine: string }; task: string };
/** What this Mac holds. */
let mac: { projectId: string; threadId: string; runId: string; taskId: string };

beforeAll(async () => {
  stand = await standIn({ signup: "open" });
  stand.setBilling(ME, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(ME, [{ agent: "claude" }]);
  stand.setPerson(MARA, { name: "Mara Okafor", image: null });
  stand.tasks.enabled = true;
  const birch = stand.addTeam("Birch Studio", [MARA, ME]);
  const alder = stand.addTeam("Alder Works", [ME]);
  const personalProject = stand.addProject(ME, { name: "Canvas", fullName: REPOSITORY });
  const birchProject = stand.addProject(MARA, { name: "Canvas", fullName: REPOSITORY }, birch);
  const alderProject = stand.addProject(ME, { name: "Canvas", fullName: REPOSITORY }, alder);
  cloud = {
    birch,
    alder,
    projects: [personalProject, birchProject, alderProject],
    threads: {
      personal: stand.addThread(ME, { projectId: personalProject, title: "Personal cloud draft" }),
      teammate: stand.addThread(MARA, { projectId: birchProject, title: "Birch pricing page", status: "working" }),
      mine: stand.addThread(ME, { projectId: alderProject, title: "Alder checkout" }),
    },
    task: stand.tasks.seed(birch, MARA, birchProject, { title: "Birch launch checklist" }).id,
  };

  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-installed-phone-cloud-"));
  let token: string | null = null;
  let secret: string | null = null;
  core = await OpenOrc.create({
    dataDir: path.join(folder, "data"),
    ephemeral: true,
    transport: { push: (push) => void windowPushes.push(push) },
    accountServer: stand.url,
    accountSecrets: { load: async () => token, save: async (value) => void (token = value) },
    openBrowser: (url) => {
      if (new URL(url).pathname === "/sign-in") void fetch(stand.signInPage(url, ME));
    },
    remoteSecrets: { load: async () => secret, save: async (value) => void (secret = value) },
    remoteNetwork: { port: 0, machine: { name: () => "QA", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] } },
  });
  const project = projects.insert(core.db, { name: "Canvas", rootPath: path.join(folder, "canvas"), gitRemote: `https://github.com/${REPOSITORY}.git`, defaultBranch: "main", settings: {} });
  const thread = threads.insert(core.db, { projectId: project.id, title: "Mac retry fix", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const run = runs.insert(core.db, { id: "mac-run", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const task = tasks.insert(core.db, { projectId: project.id, title: "Mac task", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
  mac = { projectId: project.id, threadId: thread.id, runId: run.id, taskId: task.id };

  // As the app attaches phones: the origin goes with every request.
  await core.remote.attach((request, origin) => core.handle(request, origin));
  await core.remote.configure(true);
  await window("account.signIn", {});
  await vi.waitFor(async () => expect(await window("spaces.status", {})).toMatchObject({ state: "ready" }), { timeout: 5_000 });
}, 30_000);

afterAll(async () => {
  phones.forEach((phone) => phone.close());
  await core.close();
  await stand.close();
  await rm(folder, { recursive: true, force: true });
});

async function phone(build: InstalledBuild): Promise<RemoteTestClient> {
  const paired = await RemoteTestClient.pair((await core.remote.beginPairing()).url, { name: build.name });
  if (typeof paired === "string") throw new Error(paired);
  phones.push(paired);
  if (build.capabilities) await expect(paired.request("session.negotiate", { capabilities: build.capabilities })).resolves.toEqual({ capabilities: build.capabilities });
  return paired;
}

const frames = (pushes: readonly (RemotePush | Broadcast)[], runId: string) => pushes.flatMap((push) => (push.type === "frame" && push.frame.runId === runId ? push.frame.events : []));
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

/** What a phone with no account could only have heard of the account from the Mac: its ids, and its words. */
const accountIds = () => [cloud.birch, cloud.alder, ...cloud.projects, ...Object.values(cloud.threads), cloud.task];
const accountWords = () => ["Birch Studio", "Alder Works", "Birch pricing page", "Personal cloud draft", "Alder checkout", "Birch launch checklist", "Mara", MARA, ME, stand.url];
/** The one thing of the account a Mac thread carries today: the reference in a Mac agent's own task result. */
const taskResult = () => JSON.stringify({ id: cloud.task, status: "backlog", taskRef: { place: "server", spaceId: cloud.birch, projectId: cloud.projects[1]!, id: cloud.task } });

it("holds the account's threads for its own windows, so what the phones are refused below is really there", async () => {
  await vi.waitFor(async () => expect(ids(await window("threads.list", { spaceId: cloud.birch }))).toEqual(expect.arrayContaining([cloud.threads.teammate, mac.threadId])), { timeout: 5_000 });
  expect(await window("threads.get", { id: cloud.threads.teammate })).toMatchObject({ title: "Birch pricing page", owner: { brain: "hosted" } });
  expect((await window("spaces.projects", { spaceId: cloud.alder })).map((project) => project.name)).toEqual(["Canvas"]);
  expect(await window("tasks.online.get", { spaceId: cloud.birch, id: cloud.task })).toMatchObject({ task: { title: "Birch launch checklist" } });
});

describe.each(INSTALLED_BUILDS)("$name", (build) => {
  let installed: RemoteTestClient;
  beforeAll(async () => {
    installed = await phone(build);
  });

  it("reads this Mac's pairing code and hello", async () => {
    const offer = build.reader.decodePairingUrl((await core.remote.beginPairing()).url);
    const ws = new WebSocket(linkUrl(offer.routes[0]!, offer.macKey, nodeCrypto));
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
    const hello = await rawMacHello({
      socket: linkSocket(ws),
      crypto: nodeCrypto,
      device: nodeCrypto.generateKeyPair(),
      macKey: offer.macKey,
      pair: { offerId: offer.offerId, secret: toBase64Url(offer.secret) },
    });
    expect(build.reader.parseMacHello(hello)).toMatchObject({ t: "hello", mac: { name: "QA" }, routes: offer.routes });
  });

  it("lists this Mac's projects and threads alone, however it asks", async () => {
    expect(ids(await installed.call("projects.list", {}))).toEqual([mac.projectId]);
    const home = { projectIds: [mac.projectId], filter: "active" as const, orderBy: "activity" as const, includeChildren: true };
    for (const params of [{}, { projectId: mac.projectId }, { ...home, limit: 51 }, { ...home, pinnedOnly: true }, { ...home, needsYou: true, limit: 50 }, { ...home, filter: "archived" as const }])
      expect(ids(await installed.call("threads.list", params)).every((id) => id === mac.threadId)).toBe(true);
    expect(ids(await installed.call("threads.list", { ...home, limit: 51 }))).toEqual([mac.threadId]);
    // No installed build names a space or one of the account's projects; one that did would still hear of this Mac only.
    for (const params of [{ spaceId: cloud.birch }, { spaceId: cloud.alder, limit: 51 }, { projectId: cloud.projects[1]! }, { projectIds: cloud.projects }]) {
      const rows = await installed.request("threads.list", params).catch(() => []);
      expect(ids(rows as { id: string }[]).every((id) => id === mac.threadId)).toBe(true);
    }
    // The Mac's one thread has been quiet; the account's three are not counted with it.
    expect(await installed.call("threads.resolvedCount", { projectIds: [mac.projectId, ...cloud.projects], quietBefore: Date.now() + 1 })).toBe(1);
    expect((await installed.call("inbox.list", {})).items.every((item) => item.kind !== "thread" || item.thread.id === mac.threadId)).toBe(true);
  });

  it("reaches nothing of a cloud thread by its ids and writes nothing to the account", async () => {
    const writes = { sent: stand.sent.length, answered: stand.answered.length, started: stand.started.length, readies: stand.readies.length };
    const requests = stand.requests.length;
    const ask = stand.ask(cloud.threads.teammate, { kind: "command", toolName: "Bash", input: { command: "pnpm build" }, detail: "Run the build" });
    for (const threadId of Object.values(cloud.threads)) {
      const runId = hostedRunId(threadId);
      expect(await installed.request("threads.get", { id: threadId })).toBeNull();
      expect(await installed.request("runs.listForThread", { threadId }).catch(() => [])).toEqual([]);
      expect(await installed.request("events.page", { runId })).toMatchObject({ events: [], live: false });
      expect(await installed.request("threads.lastMessage", { id: threadId }).catch(() => null)).toBeNull();
      expect(await installed.request("threads.messages", { id: threadId }).catch(() => [])).toEqual([]);
      const settings = { agent: "claude", mode: "act", permissionMode: "trusted" };
      await expect(installed.request("runs.start", { threadId, ...settings, prompt: "From a phone" })).rejects.toThrow("not found");
      await expect(installed.request("runs.send", { runId, text: "From a phone" })).rejects.toThrow("is not live");
      await expect(installed.request("threads.queue", { id: threadId, text: "From a phone" })).rejects.toThrow("not found");
      await expect(installed.request("threads.update", { id: threadId, patch: { title: "Renamed from a phone" } })).rejects.toThrow("not found");
      // This Mac has no such run and no such request, so both do nothing, as for any run that has ended.
      expect(await installed.request("runs.interrupt", { runId })).toBeNull();
      expect(await installed.request("approvals.resolve", { runId, approvalId: ask, decision: "allow" })).toBeNull();
    }
    for (const projectId of cloud.projects)
      await expect(installed.request("threads.start", { projectId, agent: "claude", mode: "act", permissionMode: "trusted", workspaceMode: "current", prompt: "From a phone" })).rejects.toThrow();
    expect({ sent: stand.sent.length, answered: stand.answered.length, started: stand.started.length, readies: stand.readies.length }).toEqual(writes);
    expect(stand.requests.slice(requests).filter((request) => request.method !== "GET")).toEqual([]);
    expect(await window("threads.get", { id: cloud.threads.teammate })).toMatchObject({ title: "Birch pricing page" });
  });

  it("is refused every method of the account, of spaces, of working together, of team tasks and of team chat", async () => {
    const families = /^(account|spaces|organization|hosted|hostedFiles|teamChat)\.|^tasks\.online\.|^threads\.(collaboration|authors|people|startQueued|retrySave|notes|postNote|readNotes)$/;
    const methods = Object.keys(rpcParams).filter((method) => families.test(method));
    expect(methods.length).toBeGreaterThan(80);
    expect(methods.filter(isRemoteMethod)).toEqual([]);
    for (const method of methods) await expect(installed.request(method, { spaceId: cloud.birch, threadId: cloud.threads.teammate, id: cloud.task })).rejects.toThrow(FROM_PHONE);
  });

  it("hears nothing of a cloud thread that streams to a window, and every event of a Mac thread its transcript can take", async () => {
    const cloudRun = hostedRunId(cloud.threads.teammate);
    installed.interest([mac.runId, cloudRun]);
    // The window opens the cloud thread, which makes this Mac follow it.
    await window("events.page", { runId: cloudRun });
    stand.append(cloud.threads.teammate, [{ type: "message.completed", ts: Date.now(), messageId: `cloud-${build.name}`, role: "assistant", text: "Birch pricing page is drafted" }]);
    stand.set(cloud.threads.teammate, { status: "needs_answer" });
    await vi.waitFor(() => expect(frames(windowPushes, cloudRun).some((event) => event.type === "message.completed" && event.messageId === `cloud-${build.name}`)).toBe(true), { timeout: 5_000 });

    const sent = everyEvent(mac.runId).map((event) => ({ ...event, eventId: `${build.name}-${event.eventId}` }));
    for (const event of sent) {
      core.ledger.push(event);
      core.frames.push(event);
    }
    const live = () => frames(installed.pushes, mac.runId);
    await vi.waitFor(() => expect(live().some((event) => event.type === "session.completed" && event.eventId?.startsWith(build.name))).toBe(true), { timeout: 5_000 });
    expect(frames(installed.pushes, cloudRun)).toEqual([]);
    expect(installed.pushes.filter((push) => push.type === "notify" && push.threadId !== mac.threadId)).toEqual([]);

    const page = await installed.call("events.page", { runId: mac.runId });
    for (const delivered of [live(), page.events]) {
      const run = build.transcript.emptyRun(mac.runId);
      expect(() => build.transcript.applyEvents(run, delivered)).not.toThrow();
      expect(run.blocks.some((block) => block.kind === "message" && block["text"] === "The store publishes once per frame.")).toBe(true);
    }
  });

  it("reads a Mac agent's task result that names a server's task as its own tool output, and never the server's task", async () => {
    const result: AgentEvent = {
      type: "tool.completed",
      runId: mac.runId,
      ts: Date.now(),
      eventId: `${build.name}-task-result`,
      toolCallId: `${build.name}-task-call`,
      name: "mcp__openorc__task_create",
      output: { content: [{ type: "text", text: taskResult() }] },
      isError: false,
    };
    core.ledger.push(result);
    core.frames.push(result);
    const delivered = () => frames(installed.pushes, mac.runId).filter((event) => event.eventId === result.eventId);
    await vi.waitFor(() => expect(delivered()).toHaveLength(1), { timeout: 5_000 });
    const page = await installed.call("events.page", { runId: mac.runId });
    for (const event of [...delivered(), ...page.events.filter((each) => each.eventId === result.eventId)]) {
      const parsed = (build.capabilities ? installedTaskEvents.testFlight : installedTaskEvents.appStore).parse(event);
      expect(installedTaskIdFromTool({ name: parsed.name, output: parsed.output, done: true, isError: parsed.isError })).toBe(cloud.task);
    }
    // The card of the later builds asks the Mac for that id and keeps the call's row when there is no such task.
    expect(await installed.request("tasks.get", { id: cloud.task }).catch(() => null)).toBeNull();
    const board = JSON.stringify(await installed.request("tasks.board", {}));
    expect(board).toContain("Mac task");
    expect(board).not.toContain(cloud.task);
    expect(board).not.toContain("Birch launch checklist");
  });

  it("was sent only messages its build reads, and nothing that names the account", () => {
    expect(installed.received.length).toBeGreaterThan(100);
    for (const message of installed.received) expect(() => installedMacMessage(message)).not.toThrow();
    // A refusal may repeat the id the phone itself sent; nothing else may hold one.
    const answers = JSON.stringify(installed.received.filter((message) => message.t !== "rpc.error")).replaceAll(JSON.stringify(taskResult()).slice(1, -1), "");
    expect(accountIds().filter((id) => answers.includes(id))).toEqual([]);
    const heard = JSON.stringify(installed.received);
    expect(accountWords().filter((word) => heard.includes(word))).toEqual([]);
    expect(installed.closed).toBe(false);
  });
});

it("has a sample of every event type a Mac can send, each one valid today", () => {
  const sampled = everyEvent("sample");
  for (const event of sampled) expect(AgentEvent.safeParse(event).error?.message).toBeUndefined();
  expect([...new Set(sampled.map((event) => event.type))].sort()).toEqual(AgentEvent.options.map((option) => option.shape.type.value).sort());
});

it("keeps what every build refuses: one more field in a hello, a push by another name, a message of another kind", async () => {
  const offer = INSTALLED_BUILDS[0].reader.decodePairingUrl((await core.remote.beginPairing()).url);
  const hello = { t: "hello", version: 1, mac: { name: "QA" }, deviceId: "device", routes: offer.routes };
  for (const build of INSTALLED_BUILDS) {
    expect(build.reader.parseMacHello(hello)).toMatchObject({ t: "hello" });
    expect(() => build.reader.parseMacHello({ ...hello, account: { signedIn: true } })).toThrow();
  }
  expect(() => installedMacMessage({ t: "push", push: { type: "ready" } })).not.toThrow();
  expect(() => installedMacMessage({ t: "push", push: { type: "account" } })).toThrow();
  expect(() => installedMacMessage({ t: "push", push: { type: "ready" }, space: "personal" })).toThrow();
  expect(() => installedMacMessage({ t: "note", id: 1 })).toThrow();
  expect(() => installedMacMessage({ t: "rpc.error", id: 1, message: "No", code: "organization_frozen" })).toThrow();
});

it("keeps the App Store build's own failure: an event type it does not know throws in its transcript", () => {
  const appStore = INSTALLED_BUILDS[0].transcript;
  expect(() => appStore.applyEvents(appStore.emptyRun("sample"), everyEvent("sample"))).toThrow(TypeError);
  const release = INSTALLED_BUILDS[4].transcript;
  const run = release.emptyRun("sample");
  expect(() => release.applyEvents(run, [...everyEvent("sample"), { type: "future.event", runId: "sample", ts: 1 }])).not.toThrow();
  expect(run.blocks.length).toBeGreaterThan(5);
});

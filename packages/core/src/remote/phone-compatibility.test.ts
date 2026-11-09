import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { projects, runs, threads } from "@openorc/db";
import { linkUrl, toBase64Url } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { INSTALLED_PHONES, rawMacHello } from "@openorc/link/test-fixtures/installed-phone";
import { defaultOrclingLook, type AgentEvent } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { RemoteTestClient } from "./test-client.js";
import { linkSocket } from "./ws-socket.js";

let core: OpenOrc;
let dataDir: string;
const phones: RemoteTestClient[] = [];
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-phone-compat-test-"));
  let secret: string | null = null;
  core = await OpenOrc.create({
    dataDir,
    ephemeral: true,
    transport: { push() {} },
    remoteSecrets: {
      load: async () => secret,
      save: async (value) => {
        secret = value;
      },
    },
    remoteNetwork: { port: 0, machine: { name: () => "QA", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] } },
  });
  await core.remote.attach((request) => core.handle(request));
  await core.remote.configure(true);
});
afterAll(async () => {
  phones.forEach((phone) => phone.close());
  await core.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function phone(capable = false) {
  const result = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
  if (typeof result === "string") throw new Error(result);
  phones.push(result);
  if (capable) await expect(result.request("session.negotiate", { capabilities: ["subagent-threads", "future-capability"] })).resolves.toEqual({ capabilities: ["subagent-threads"] });
  return result;
}

it.each(Object.entries(INSTALLED_PHONES))("speaks a pairing code and a hello the installed %s build reads", async (_build, installed) => {
  const offer = installed.decodePairingUrl((await core.remote.beginPairing()).url);
  const ws = new WebSocket(linkUrl(offer.routes[0]!, offer.macKey, nodeCrypto));
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const hello = await rawMacHello({
    socket: linkSocket(ws),
    crypto: nodeCrypto,
    device: nodeCrypto.generateKeyPair(),
    macKey: offer.macKey,
    pair: { offerId: offer.offerId, secret: toBase64Url(offer.secret) },
  });
  expect(installed.parseMacHello(hello)).toMatchObject({ t: "hello", mac: { name: "QA" }, routes: offer.routes });
});

it("gates legacy live frames and history while a capable session gets the same subagent events", async () => {
  const project = projects.insert(core.db, { name: "Compatibility", rootPath: dataDir, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(core.db, { projectId: project.id, title: "Parent", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const run = runs.insert(core.db, { id: "compat-run", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const legacy = await phone();
  legacy.interest([run.id]);
  await legacy.call("projects.list", {});
  const base = { runId: run.id, ts: 1, subagentId: "native-child" };
  const events: AgentEvent[] = [
    { ...base, type: "message.completed", messageId: "answer", role: "assistant", text: "The parent still answers" },
    { ...base, type: "subagent.started", threadId: "child", title: "Read docs" },
    { ...base, type: "subagent.updated", threadId: "child", status: "completed" },
    { ...base, type: "future.event" } as unknown as AgentEvent,
  ];
  for (const event of events) {
    core.ledger.push(event);
    core.frames.push(event);
  }
  const page = await legacy.call("events.page", { runId: run.id });
  const streamed = () => legacy.pushes.flatMap((push) => (push.type === "frame" && push.frame.runId === run.id ? push.frame.events : []));
  await vi.waitFor(() => expect(streamed().length).toBeGreaterThan(0));
  for (const delivered of [streamed(), page.events]) {
    expect(delivered.map((event) => event.type)).toEqual(["message.completed"]);
    expect(delivered.every((event) => !Object.hasOwn(event, "subagentId"))).toBe(true);
  }
  await expect(legacy.request("events.listForRun", { runId: run.id })).rejects.toThrow("not available from a phone");
  const capable = await phone(true);
  capable.interest([run.id]);
  const capablePage = await capable.call("events.page", { runId: run.id });
  expect(capablePage.events.map((event) => event.type)).toEqual(events.map((event) => event.type));
  expect(capablePage.events.every((event) => event.subagentId === base.subagentId)).toBe(true);
  for (const event of events) core.frames.push(event);
  await vi.waitFor(() => expect(capable.pushes.some((push) => push.type === "frame" && push.frame.events.some((event) => event.type === "subagent.started"))).toBe(true));
  expect(streamed().every((event) => event.type === "message.completed" && !Object.hasOwn(event, "subagentId"))).toBe(true);
});

it("excludes subagents before legacy list pagination, even when children are explicitly requested", async () => {
  const project = projects.insert(core.db, { name: "Lists", rootPath: path.join(dataDir, "lists"), gitRemote: null, defaultBranch: "main", settings: {} });
  const root = threads.insert(core.db, { projectId: project.id, title: "Root", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const child = threads.insert(core.db, { projectId: project.id, title: "Child", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  threads.update(core.db, child.id, { parentThreadId: root.id, parentRelation: "subagent" });
  core.db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(root.lastActivityAt + 1, child.id);
  const legacy = await phone();
  expect((await legacy.call("threads.list", { projectId: project.id, limit: 1, includeChildren: true })).map((thread) => thread.id)).toEqual([root.id]);
  expect((await legacy.call("threads.list", { projectId: project.id, limit: 1 })).map((thread) => thread.id)).toEqual([root.id]);
  expect(await legacy.call("threads.get", { id: child.id })).toBeNull();
  const capable = await phone(true);
  expect((await capable.call("threads.list", { projectId: project.id, limit: 1, includeChildren: true })).map((thread) => thread.id)).toContain(child.id);
  expect(await capable.call("threads.get", { id: child.id })).toMatchObject({ id: child.id });
});

it("hides child inbox entries and notifications from legacy sessions, preserving both for capable phones", async () => {
  const project = projects.insert(core.db, { name: "Inbox", rootPath: path.join(dataDir, "inbox"), gitRemote: null, defaultBranch: "main", settings: {} });
  const root = threads.insert(core.db, { projectId: project.id, title: "Root", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const child = threads.insert(core.db, { projectId: project.id, title: "Child", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  threads.update(core.db, child.id, { parentThreadId: root.id, parentRelation: "subagent" });
  const pending = vi.spyOn(core.runs, "pending").mockReturnValue([
    { runId: "root-run", approvalId: "root-approval", taskId: null, threadId: root.id, detail: "Root approval" },
    { runId: "child-run", approvalId: "child-approval", taskId: null, threadId: child.id, detail: "Child approval" },
  ]);
  try {
    const legacy = await phone();
    const capable = await phone(true);
    expect((await legacy.call("inbox.list", {})).items.map((item) => item.runId)).toEqual(["root-run"]);
    expect((await capable.call("inbox.list", {})).items.map((item) => item.runId)).toEqual(["root-run", "child-run"]);
    for (const threadId of [child.id, root.id])
      core.remote.publish({ type: "notify", id: threadId, kind: "approval", threadId, taskId: null, title: "Approval", body: "Needs you", runId: `${threadId}-run`, approvalId: "approval" });
    // An RPC flushes the notification queue before its reply.
    await legacy.call("projects.list", {});
    await capable.call("projects.list", {});
    const notifications = (client: RemoteTestClient) => client.pushes.filter((push) => push.type === "notify").map((push) => push.threadId);
    expect(notifications(legacy)).toEqual([root.id]);
    expect(notifications(capable)).toEqual([child.id, root.id]);
  } finally {
    pending.mockRestore();
  }
});

it("lists Orclings to a phone by face, name and conversation, opens one's profile with its text redacted, and saves its check-ins", async () => {
  const pip = await core.orclings.create({ name: "Pip", look: defaultOrclingLook, settings: { agent: "codex", model: "fixture", effort: null, fastMode: false }, permission: "allow" });
  const capable = await phone();
  await expect(capable.request("session.negotiate", { capabilities: ["orclings"] })).resolves.toEqual({ capabilities: ["orclings"] });
  const [chat] = await capable.call("orclings.chats", {});
  expect(Object.keys(chat!).sort()).toEqual(["id", "last", "look", "name", "thread", "threadId"]);
  expect(chat).toMatchObject({ id: pip.id, name: "Pip", look: defaultOrclingLook, threadId: pip.threadId, thread: { id: pip.threadId }, last: null });
  await expect(capable.call("orclings.reactions", { threadId: pip.threadId })).resolves.toEqual([]);
  core.orclings.saveInstructions(pip.id, "Ping me when CI breaks. Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12", "user", null);
  const profile = await capable.call("orclings.profile", { id: pip.id });
  expect(Object.keys(profile).sort()).toEqual(["claudeAccountId", "id", "instructions", "look", "memories", "name", "permission", "settings", "wakes"]);
  expect(profile).toMatchObject({ id: pip.id, name: "Pip", permission: "allow", settings: { agent: "codex", model: "fixture" }, wakes: [], memories: [] });
  expect(profile.instructions).toBe("Ping me when CI breaks. Token [redacted:github-token]");
  const saved = await capable.call("orclings.wakes.save", { id: pip.id, wakes: [{ kind: "startup" }, { kind: "time", at: "09:00", days: [1, 2, 3, 4, 5] }] });
  expect(saved.wakes).toEqual([{ kind: "startup" }, { kind: "time", at: "09:00", days: [1, 2, 3, 4, 5] }]);
  await expect(capable.request("orclings.instructions.save", { id: pip.id, body: "Something else" })).rejects.toThrow("These instructions hold a secret, so edit them on your Mac.");
  expect(core.orclings.instructions(pip.id)[0]?.body).toContain("ghp_");
  await expect(capable.request("orclings.list", {})).rejects.toThrow();
});

it("makes an Orcling for a phone, saves its changes and instructions, and deletes it, as the Mac's designer and panel do", async () => {
  const capable = await phone();
  await expect(capable.request("session.negotiate", { capabilities: ["orclings", "orcling-edits"] })).resolves.toEqual({ capabilities: ["orclings", "orcling-edits"] });
  const rex = await capable.call("orclings.create", {
    draft: { name: "Rex", look: defaultOrclingLook, settings: { agent: "codex", model: "fixture", effort: null, fastMode: false }, permission: "approve" },
  });
  expect(core.orclings.get(rex.id)).toMatchObject({ name: "Rex", permission: "approve", threadId: rex.threadId });
  expect(core.threads.get(rex.threadId)).toMatchObject({ orclingId: rex.id });
  const profile = await capable.call("orclings.profile", { id: rex.id });
  const draft = { name: "Rexy", look: { ...profile.look, shape: 2, bodyColor: "#ec7ba8" }, settings: { ...profile.settings, effort: "high" }, permission: "allow" as const };
  await expect(capable.call("orclings.update", { id: rex.id, draft })).resolves.toMatchObject({ ...draft, claudeAccountId: profile.claudeAccountId });
  expect(core.orclings.get(rex.id)).toMatchObject({ ...draft, claudeAccountId: rex.claudeAccountId });
  await expect(capable.call("orclings.profile", { id: rex.id })).resolves.toMatchObject({ name: "Rexy", permission: "allow" });
  await expect(capable.call("orclings.instructions.save", { id: rex.id, body: "Keep it short." })).resolves.toMatchObject({ body: "Keep it short.", author: "user" });
  expect(core.orclings.instructions(rex.id)[0]?.body).toBe("Keep it short.");
  await expect(capable.call("orclings.delete", { id: rex.id })).resolves.toBeNull();
  expect(core.orclings.list().map((orcling) => orcling.id)).not.toContain(rex.id);
});

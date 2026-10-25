import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { decodePairingUrl, openPush, pushKeys, type PushEnvelope } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { PHONE_APP, type CorePush, type Project } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { FakeApns } from "./remote/push/fake-apns.js";
import { RemoteTestClient } from "./remote/test-client.js";
import type { ProtectedSecretStore } from "./services/extraction-credentials.js";

const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
const machine = { name: () => "Studio", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pushKey = { keyId: "ABC123DEFG", pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };

function memorySecrets(): ProtectedSecretStore {
  let value: string | null = null;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

let root: string, dataDir: string, core: OpenOrc, project: Project, apns: FakeApns, phone: RemoteTestClient, macKey: Uint8Array, token: string;
const pushed: CorePush[] = [];
const live: string[] = [];
const handles = new Map<string, RunHandle>();
const notices = () => pushed.filter((message): message is Extract<CorePush, { type: "notify" }> => message.type === "notify");

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-phone-alerts-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-phone-alerts-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Phone alerts\n");
  await commitAll(root, "init");
  apns = await FakeApns.start({ publicKey, keyId: pushKey.keyId, teamId: PHONE_APP.teamId, topic: PHONE_APP.bundleId });
  core = await OpenOrc.create({
    dataDir,
    ephemeral: true,
    transport: { push: (message) => pushed.push(message) },
    remoteSecrets: memorySecrets(),
    pushSecrets: memorySecrets(),
    remoteNetwork: { port: 0, machine, apns: { sandbox: apns.origin, production: apns.origin } },
  });
  await core.remote.attach((request) => core.handle(request));
  await core.remote.configure(true);
  project = await core.projects.import(root);
  const { url } = await core.remote.beginPairing();
  macKey = decodePairingUrl(url).macKey;
  const paired = await RemoteTestClient.pair(url, { name: "David's iPhone" });
  if (typeof paired === "string") throw new Error(paired);
  phone = paired;
  token = randomBytes(32).toString("hex");
  expect(await phone.device("push.register", { registration: { token, environment: "sandbox", alerts: "all", sound: true } })).toEqual({ sandbox: "no-key", production: "no-key" });
  await core.remote.setPushKey(pushKey.keyId, pushKey.pem);
  expect(await phone.device("push.register", { registration: { token, environment: "sandbox", alerts: "all", sound: true } })).toEqual({ sandbox: "ready", production: "ready" });
});
beforeEach(() => {
  pushed.splice(0);
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      interrupt() {},
      send: async () => {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    handles.set(spec.runId, handle);
    return handle;
  });
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  core.settings.set({ notifications: true });
  vi.restoreAllMocks();
});
afterAll(async () => {
  phone?.close();
  await core?.close();
  await apns?.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function soloRun(title = "Needs you") {
  const thread = threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Work", resume: false });
  live.push(run.id);
  return { thread, run };
}

/** A task started from a thread: its runs keep apart from the thread's conversation. */
async function taskRun(title = "Fix the flaky test") {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Plan the release", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const task = tasks.insert(core.db, { projectId: project.id, threadId: thread.id, title, spec: "Work", priority: "none", labels: [], workspaceMode: "current", baseRef: "main", parentTaskId: null });
  const run = await core.runs.start({ scope: { task, thread: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Work", resume: false });
  live.push(run.id);
  return { thread, task, run };
}

/**
 * Whether the phone, reading the thread an alert opens the way its thread screen does, finds the run the alert's
 * Allow and Deny answer: in the thread's conversation, or among the thread's tasks waiting in the inbox.
 */
async function phoneFinds(threadId: string, runId: string): Promise<boolean> {
  const conversation = await phone.call("runs.listForThread", { threadId });
  const { items } = await phone.call("inbox.list", {});
  return conversation.some((run) => run.id === runId) || items.some((item) => item.kind === "task" && item.runId === runId && item.task.threadId === threadId);
}

/** What the phone's extension reads from an alert the fake APNs took. */
const openedFrom = (request: (typeof apns.requests)[number]) => openPush(nodeCrypto, pushKeys(nodeCrypto, phone.keys, macKey, "phone").seal, (JSON.parse(request.body) as { o: PushEnvelope }).o);
const opened = () => apns.requests.map(openedFrom);

/** The alerts the fake APNs took for one approval, and what the phone reads from each. */
function alertsFor(approvalId: string) {
  return apns.requests.flatMap((request) => {
    const notice = openedFrom(request);
    return notice?.approval?.approvalId === approvalId ? [{ request, notice }] : [];
  });
}

describe("notices for phones", () => {
  it("names the run and approval in a solo approval's and question's notice, for Allow and Deny on a phone", async () => {
    const alert = vi.spyOn(core.remote, "alert");
    const { thread, run } = await soloRun();
    const approval = core.runs.requestApproval(run.id, "approval-1", "Bash", { command: "ls" });
    const question = core.runs.requestApproval(run.id, "question-1", "AskUserQuestion", { questions: [{ question: "Which option?" }] });

    expect(notices()).toEqual([
      expect.objectContaining({ kind: "approval", threadId: thread.id, runId: run.id, approvalId: "approval-1", body: "Codex wants to run ls" }),
      expect.objectContaining({ kind: "question", threadId: thread.id, runId: run.id, approvalId: "question-1" }),
    ]);
    expect(alert.mock.calls.map(([notice]) => notice)).toEqual(notices());

    core.runs.resolveApproval(run.id, "approval-1", "deny");
    core.runs.resolveApproval(run.id, "question-1", "deny");
    await Promise.all([approval, question]);
  });

  it("still hands phones a notice while Desktop notifications is off, and keeps it from windows", async () => {
    const alert = vi.spyOn(core.remote, "alert");
    core.settings.set({ notifications: false });
    const { thread, run } = await soloRun();
    const approval = core.runs.requestApproval(run.id, "approval-2", "Bash", { command: "ls" });

    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "notify", kind: "approval", threadId: thread.id, runId: run.id, approvalId: "approval-2", id: expect.any(String) }));
    expect(notices()).toEqual([]);

    core.runs.resolveApproval(run.id, "approval-2", "deny");
    await approval;
  });
});

describe("a finished turn, from the agent to the phone's lock screen", () => {
  it("masks a secret before the reply is cut, so no part of one that starts near the cut is sealed", async () => {
    const secret = "ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5";
    const leaks = (text: string) => Array.from({ length: secret.length - 4 }, (_, i) => secret.slice(i, i + 5)).some((part) => text.includes(part));
    const titles = [100, 104, 110, 120, 135].map((at) => `Pushed at ${at}`);
    for (const title of titles) {
      const { run } = await soloRun(title);
      const at = Number(title.split(" ").at(-1));
      const reply = `${"x".repeat(at)} ${secret} for the push, rotate it after.`;
      handles.get(run.id)!.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "1", durationMs: 1, status: "success", resultText: reply });
    }
    const sealed = () => opened().filter((notice) => notice?.kind === "finished" && titles.includes(notice.title));
    await expect.poll(() => sealed().length).toBe(titles.length);

    expect(sealed().filter((notice) => leaks(JSON.stringify(notice)))).toEqual([]);
    expect(sealed().find((notice) => notice?.title === "Pushed at 100")?.body).toBe(`${"x".repeat(100)} [redacted:github-token] for the push, r`);
    expect(notices().filter((notice) => notice.kind === "finished" && leaks(notice.body))).toEqual([]);
  });
});

describe("an approval, from the agent to the phone's lock screen", () => {
  it("reaches APNs sealed for the paired phone, redacted, with the ids Allow and Deny need, while Desktop notifications is off", async () => {
    core.settings.set({ notifications: false });
    const { thread, run } = await soloRun("Release");
    const approval = core.runs.requestApproval(run.id, "approval-3", "Bash", { command: `git push https://${GITHUB_TOKEN}@github.com/o/r` });
    await expect.poll(() => alertsFor("approval-3")).toHaveLength(1);

    expect(apns.problems).toEqual([]);
    const [{ request, notice }] = alertsFor("approval-3") as [ReturnType<typeof alertsFor>[number]];
    expect(request.token).toBe(token);
    expect(request.headers["apns-priority"]).toBe("10");
    expect(request.body).not.toMatch(/Release|git push|approval-3/);
    expect(notice).toEqual({
      id: expect.any(String),
      kind: "approval",
      threadId: thread.id,
      title: "Release",
      body: "Codex wants to run git push https://[redacted:github-token]@github.com/o/r",
      approval: { runId: run.id, approvalId: "approval-3" },
    });
    expect(notices()).toEqual([]);

    core.runs.resolveApproval(run.id, "approval-3", "deny");
    await approval;
  });

  it("opens a task run's approval on its task's thread, where the phone finds it and its answer lands", async () => {
    const { thread, task, run } = await taskRun();
    const approval = core.runs.requestApproval(run.id, "approval-7", "Bash", { command: "pnpm test" });
    await expect.poll(() => alertsFor("approval-7")).toHaveLength(1);
    const [{ notice }] = alertsFor("approval-7") as [ReturnType<typeof alertsFor>[number]];
    expect(notice).toMatchObject({ kind: "approval", threadId: thread.id, title: task.title, approval: { runId: run.id, approvalId: "approval-7" } });

    expect(await phoneFinds(thread.id, run.id)).toBe(true);
    await phone.call("approvals.resolve", { runId: run.id, approvalId: "approval-7", decision: "allow" });
    expect(await approval).toMatchObject({ decision: "allow" });
  });

  it("opens a task run's question on its task's thread too, where the phone finds the run to answer it", async () => {
    const { thread, run } = await taskRun("Ask first");
    const question = core.runs.requestApproval(run.id, "question-2", "AskUserQuestion", { questions: [{ question: "Which option?" }] });
    const asked = () => opened().filter((notice) => notice?.kind === "question" && notice.title === "Ask first");
    await expect.poll(asked).toHaveLength(1);
    expect(asked()[0]).toMatchObject({ threadId: thread.id });
    expect(await phoneFinds(asked()[0]!.threadId!, run.id)).toBe(true);

    core.runs.resolveApproval(run.id, "question-2", "deny");
    await question;
  });

  it("drops alerts still waiting when phone access turns off, and closes its connection to Apple", async () => {
    const [first, second] = [await soloRun("First"), await soloRun("Second")];
    const before = apns.requests.length;
    apns.reply("silence");
    const approvals = [core.runs.requestApproval(first.run.id, "approval-5", "Bash", { command: "ls" }), core.runs.requestApproval(second.run.id, "approval-6", "Bash", { command: "ls" })];
    await vi.waitFor(() => expect(apns.requests).toHaveLength(before + 1));
    await core.remote.configure(false);
    await expect.poll(() => apns.openSessions).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(apns.requests).toHaveLength(before + 1);
    expect(apns.openSessions).toBe(0);

    core.runs.resolveApproval(first.run.id, "approval-5", "deny");
    core.runs.resolveApproval(second.run.id, "approval-6", "deny");
    await Promise.all(approvals);
    await core.remote.configure(true);
  });

  it("sends nothing while phone access is off", async () => {
    await core.remote.configure(false);
    const { run } = await soloRun();
    const approval = core.runs.requestApproval(run.id, "approval-4", "Bash", { command: "ls" });
    expect(notices()).toHaveLength(1);
    core.runs.resolveApproval(run.id, "approval-4", "deny");
    await approval;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alertsFor("approval-4")).toEqual([]);
    await core.remote.configure(true);
  });
});

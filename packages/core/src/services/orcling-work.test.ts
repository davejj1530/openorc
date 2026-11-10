import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claudeAccounts, orclingFollowups, projects, runs, tasks, threads } from "@openorc/db";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { defaultOrclingLook, type AgentKind, type ModelOption, type OrclingDraft, type PlanLimits } from "@openorc/protocol";
import { createOrclingHost } from "../mcp-host/orcling.js";
import { guardContext } from "../remote/policy.js";
import { OpenOrc } from "../openorc.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const option = (agent: AgentKind, id: string, label: string, extra: Partial<ModelOption> = {}): ModelOption => ({
  id,
  label,
  agent,
  isDefault: false,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "high",
  ...extra,
});
const CATALOG: Partial<Record<AgentKind, ModelOption[]>> = {
  claude: [option("claude", "claude-opus-5-5", "Opus 5.5"), option("claude", "claude-sonnet-5-5", "Sonnet 5.5", { isDefault: true })],
  codex: [option("codex", "gpt-6", "GPT-6", { isDefault: true }), option("codex", "gpt-6-mini", "GPT-6 mini"), option("codex", "fixture", "Fixture")],
};
const draft = (name: string): OrclingDraft => ({ name, look: defaultOrclingLook, settings: { agent: "codex", model: "fixture", effort: null, fastMode: false }, permission: "allow" });

/**
 * A core whose agents answer every input with a numbered reply, except one asking them to hold, which keeps the turn
 * working, and one asking them to crash, whose process ends mid-turn. Each input is kept with the thread it went to. The person has Claude and Codex on, new threads start on
 * Codex, and the model catalog is fixed.
 */
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "openorc-orcling-work-"));
  const heard: { threadId: string; input: string }[] = [];
  let replies = 0;
  let threadOf = (_runId: string) => "";
  const scripted = (agent: "codex" | "claude") => (spec: Parameters<CodexAdapter["start"]>[0]) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    const answer = (input: string) => {
      heard.push({ threadId: threadOf(spec.runId), input });
      if (/\bhold\b/.test(input)) return;
      if (/\bcrash\b/.test(input)) return void setTimeout(() => finish(1), 0);
      setTimeout(() => {
        replies += 1;
        handle.emit("event", { type: "message.completed", runId: spec.runId, ts: Date.now(), messageId: `reply-${replies}`, role: "assistant", text: `Reply ${replies}` });
        handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: `turn-${replies}`, status: "success", durationMs: 1 });
      }, 0);
    };
    const handle = new RunHandle(spec.runId, { send: async (text) => answer(text), interrupt() {}, close: () => finish(0), done });
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent, externalSessionId: `session-${spec.runId}`, model: spec.model ?? "fixture" });
      answer(spec.prompt);
    }, 0);
    return handle;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(scripted("codex"));
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(scripted("claude"));
  const core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} } });
  threadOf = (runId) => runs.get(core.db, runId)?.threadId ?? "";
  const environment = core.environment.current();
  vi.spyOn(core.environment, "current").mockReturnValue({ ...environment, binaries: { ...environment.binaries, codex: "/fixture/codex", claude: "/fixture/claude" } });
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => CATALOG[agent!] ?? []);
  vi.spyOn(core.settings, "enabledHarnesses").mockReturnValue(["claude", "codex"]);
  const settings = core.settings.get();
  vi.spyOn(core.settings, "get").mockReturnValue({ ...settings, defaultHarness: "codex" });
  const limits: PlanLimits[] = [];
  const idle = (threadId: string) => vi.waitFor(() => expect(core.threads.get(threadId)?.activity).toBe("idle"), { timeout: 5000 });
  const host = () =>
    createOrclingHost({
      db: core.db,
      orclings: core.orclings,
      memory: core.memory,
      runs: core.runs,
      threads: core.threads,
      settings: core.settings,
      planLimits: async () => limits,
      guard: guardContext(core.db, root!),
      call: (method, params) => core.handle({ type: "rpc", id: 0, method, params }).then((reply) => (reply.type === "rpc.result" ? reply.result : Promise.reject(new Error(reply.message)))),
      send: (runId, id, text, requestKey) => core.threads.toolThreadSend(runId, id, text, requestKey),
      invalidate: () => {},
    }).orcling!;
  /** An Orcling that has said hello, with the run it speaks from, and a project to start work in. */
  const ready = async () => {
    const pip = await core.orclings.create(draft("Pip"));
    await core.threads.continueThread(pip.threadId, { agent: "codex", model: "fixture", effort: undefined, attachments: undefined, mode: "act", permissionMode: "autonomous", prompt: "hi" });
    await idle(pip.threadId);
    const project = projects.insert(core.db, { name: "Site", rootPath: root!, gitRemote: null, defaultBranch: null, settings: {} });
    return { pip, run: runs.listForThread(core.db, pip.threadId).at(-1)!.id, project };
  };
  return { core, heard, idle, host, ready, limits };
}

it("starts work for the person on the model and effort they name, and tells the Orcling once when that turn ends", async () => {
  const { core, heard, idle, host, ready } = await fixture();
  try {
    const { pip, run, project } = await ready();
    const started = JSON.parse(
      await host().startWork(run, { projectId: project.id, prompt: "Fix the flaky test", worker: { kind: "agent", model: "opus 5.5", effort: "extra high" }, reportBack: true }),
    ) as { thread: { id: string }; runsOn: string };
    expect(started.runsOn).toBe("Opus 5.5, xhigh");
    expect(threads.get(core.db, started.thread.id)).toMatchObject({ projectId: project.id, agent: "claude", model: "claude-opus-5-5", effort: "xhigh", orclingId: null });
    await vi.waitFor(() =>
      expect(heard.find((entry) => entry.threadId === started.thread.id)?.input).toMatch(
        /^Pip, the person's Orcling, started this thread for them\. It reads your replies here .*answer in this thread.*\n\nFix the flaky test/,
      ),
    );

    await idle(started.thread.id);
    await vi.waitFor(() =>
      expect(heard.filter((entry) => entry.threadId === pip.threadId).at(-1)?.input).toMatch(
        /"Fix the flaky test" in Site, which you asked to hear back from, finished its turn\. Its last reply, in its own words: "Reply \d+"/,
      ),
    );
    await idle(pip.threadId);
    expect(orclingFollowups.waiting(core.db, started.thread.id)).toBeNull();

    // The person carries on in the thread: the Orcling asked once, so it hears nothing more.
    const toPip = heard.filter((entry) => entry.threadId === pip.threadId).length;
    await core.threads.continueThread(started.thread.id, {
      agent: "claude",
      model: "claude-opus-5-5",
      effort: "xhigh",
      attachments: undefined,
      mode: "act",
      permissionMode: "autonomous",
      prompt: "and the other one",
    });
    await idle(started.thread.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard.filter((entry) => entry.threadId === pip.threadId)).toHaveLength(toPip);
    // Hearing back counts as an agent message, so a loop of steering and hearing back stops at the cap.
    expect(core.runs.agentChain(pip.threadId)).toBeGreaterThan(0);
  } finally {
    await core.close();
  }
});

it("starts on the person's usual agent and model when none is named, and names the choices when a request fits none or several", async () => {
  const { core, idle, host, ready } = await fixture();
  try {
    const { run, project } = await ready();
    const start = (worker: Record<string, unknown>) => host().startWork(run, { projectId: project.id, prompt: "Tidy up", worker: { kind: "agent", ...worker }, reportBack: false });
    const { thread: theirs } = await core.threads.start({
      agent: "codex",
      model: "gpt-6-mini",
      effort: undefined,
      attachments: undefined,
      mode: "act",
      permissionMode: "autonomous",
      prompt: "Mine",
      projectId: project.id,
      title: "Mine",
    });
    await idle(theirs.id);
    const usual = JSON.parse(await start({})) as { thread: { id: string }; runsOn: string };
    // Codex is where new threads start, on the model the person last used with it, not the one the Orcling chats on.
    expect(threads.get(core.db, usual.thread.id)).toMatchObject({ agent: "codex", model: "gpt-6-mini", effort: "high" });
    await idle(usual.thread.id);

    await expect(start({ model: "gpt-9" })).rejects.toThrow(/No model is called "gpt-9"\. Choose one of: .*Opus 5\.5 \(claude, claude-opus-5-5\)/);
    await expect(start({ model: "gpt" })).rejects.toThrow(/"gpt" fits several models: GPT-6 \(codex, gpt-6\), GPT-6 mini \(codex, gpt-6-mini\)/);
    await expect(start({ model: "opus 5.5", effort: "turbo" })).rejects.toThrow(/Opus 5\.5 takes effort low, medium, high, xhigh, max, not "turbo"/);
    await expect(start({ agent: "codex", claudeAccount: "Work" })).rejects.toThrow(/Claude accounts are for Claude/);
    await expect(start({ agent: "claude", claudeAccount: "Nope" })).rejects.toThrow(/No Claude account is called "Nope"/);
    expect(claudeAccounts.list(core.db).length).toBeGreaterThan(0);
    // Nothing started for a request that was refused.
    await expect(start({ agent: "opencode" })).rejects.toThrow(/opencode is turned off/);
    expect(
      threads
        .list(core.db, { projectId: project.id })
        .map((thread) => thread.id)
        .sort(),
    ).toEqual([theirs.id, usual.thread.id].sort());
  } finally {
    await core.close();
  }
});

it("shows the Orcling what is working or unread across projects, the models it can start on, and what is left of the person's plans", async () => {
  const { core, idle, host, ready, limits } = await fixture();
  try {
    const { pip, run, project } = await ready();
    const { thread: done } = await core.threads.start({
      agent: "codex",
      model: "fixture",
      effort: undefined,
      attachments: undefined,
      mode: "act",
      permissionMode: "autonomous",
      prompt: "Write the docs",
      projectId: project.id,
      title: "Docs",
    });
    await idle(done.id);
    const { thread: busy } = await core.threads.start({
      agent: "claude",
      model: "claude-opus-5-5",
      effort: undefined,
      attachments: undefined,
      mode: "act",
      permissionMode: "autonomous",
      prompt: "please hold",
      projectId: project.id,
      title: "Migration",
    });
    await vi.waitFor(() => expect(core.threads.get(busy.id)?.activity).toBe("running"));

    const activity = JSON.parse(await host().activity(run)) as { threads: { id: string; title: string; status: string; project: string; model: string | null; lastActive: string }[] };
    expect(activity.threads.map(({ title, status, project: place }) => ({ title, status, place }))).toEqual([
      { title: "Migration", status: "Working", place: "Site" },
      { title: "Docs", status: "Unread", place: "Site" },
    ]);
    expect(activity.threads.some((thread) => thread.id === pip.threadId)).toBe(false);
    expect(new Date(activity.threads[0]!.lastActive).getTime()).toBe(core.threads.get(busy.id)!.lastActivityAt);

    const models = JSON.parse(await host().models(run, undefined)) as {
      newThreadsStartOn: { agent: string; why: string };
      agents: { agent: string; count: number; models: { id: string; note?: string }[] }[];
    };
    expect(models.newThreadsStartOn).toEqual({ agent: "codex", why: "Chosen in Settings" });
    expect(models.agents.map((entry) => entry.agent)).toEqual(["claude", "codex"]);
    expect(models.agents[1]!.models.find((model) => model.note === "Last used")?.id).toBe("fixture");

    limits.push({
      id: "codex",
      provider: "codex",
      name: "Codex",
      plan: "Pro",
      status: "available",
      windows: [{ id: "5h", label: "5-hour window", usedPercent: 62, remainingPercent: null, resetsAt: Date.UTC(2026, 10, 10, 18), observedAt: 0, exhausted: false }],
      refreshedAt: null,
    });
    expect(JSON.parse(await host().usage(run))).toEqual([
      { plan: "Codex, Pro", agent: "codex", status: "available", windows: [{ window: "5-hour window", left: "38%", resets: "2026-11-10T18:00:00.000Z" }], checked: null },
    ]);
  } finally {
    await core.close();
  }
});

it("tells the Orcling when work it asked about fails before finishing its turn", async () => {
  const { core, heard, idle, host, ready } = await fixture();
  try {
    const { pip, run, project } = await ready();
    const started = JSON.parse(await host().startWork(run, { projectId: project.id, prompt: "crash please", worker: { kind: "agent", agent: "claude" }, reportBack: true })) as {
      thread: { id: string };
    };
    await vi.waitFor(() => expect(heard.filter((entry) => entry.threadId === pip.threadId).at(-1)?.input).toMatch(/"crash please" in Site, which you asked to hear back from, failed\./));
    await idle(pip.threadId);
    expect(orclingFollowups.waiting(core.db, started.thread.id)).toBeNull();
  } finally {
    await core.close();
  }
});

it("starts work as freely as asked, up to autonomous, and refuses more than an Approve Orcling may give", async () => {
  const { core, idle, host, ready } = await fixture();
  try {
    const { run, project } = await ready();
    const free = JSON.parse(await host().startWork(run, { projectId: project.id, prompt: "Ship it", worker: { kind: "agent" }, access: "autonomous", reportBack: false })) as {
      thread: { id: string };
      access: string;
    };
    expect(free.access).toBe("Autonomous");
    expect(threads.get(core.db, free.thread.id)).toMatchObject({ mode: "act", permissionMode: "autonomous" });
    await idle(free.thread.id);
    const planned = JSON.parse(await host().startWork(run, { projectId: project.id, prompt: "Plan it", worker: { kind: "agent" }, access: "plan", reportBack: false })) as { thread: { id: string } };
    expect(threads.get(core.db, planned.thread.id)).toMatchObject({ mode: "plan" });
    await idle(planned.thread.id);

    const careful = await core.orclings.create({ ...draft("Careful"), permission: "approve" });
    await core.threads.continueThread(careful.threadId, { agent: "codex", model: "fixture", effort: undefined, attachments: undefined, mode: "act", permissionMode: "review", prompt: "hi" });
    await idle(careful.threadId);
    const carefulRun = runs.listForThread(core.db, careful.threadId).at(-1)!.id;
    await expect(host().startWork(carefulRun, { projectId: project.id, prompt: "Ship it", worker: { kind: "agent" }, access: "autonomous", reportBack: false })).rejects.toThrow(
      /Careful is set to Approve, so work it starts can run at most on Review everything/,
    );
    expect(threads.list(core.db, { projectId: project.id })).toHaveLength(2);
  } finally {
    await core.close();
  }
});

const taskIn = (projectId: string, title: string) =>
  tasks.insert(createdDb!, { projectId, title, spec: `The spec of ${title}.`, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null, threadId: null });
let createdDb: Parameters<typeof tasks.insert>[0] | undefined;

it("does what the person could in OpenOrc: reads tasks in full, changes them, and says what it can do", async () => {
  const { core, host, ready } = await fixture();
  try {
    createdDb = core.db;
    const { pip, run, project } = await ready();
    const methods = JSON.parse(await host().appMethods(run, undefined)) as { reads: string[]; changes: string[] };
    expect(methods.reads).toEqual(expect.arrayContaining(["tasks.list", "tasks.get", "tasks.comments.list", "threads.list", "inbox.list"]));
    expect(methods.changes).toEqual(expect.arrayContaining(["tasks.update", "approvals.resolve", "review.pushThread", "threads.update", "pulls.review.start", "pulls.review.submit"]));
    expect(methods.reads).toEqual(expect.arrayContaining(["pulls.list", "pulls.diff", "pulls.review.get"]));
    // A pull request with no review drafted yet reads as none, as the Pull requests tab shows it.
    expect(await host().app(run, "pulls.review.get", { projectId: project.id, number: 7 })).toBe("null");
    expect(JSON.parse(await host().appMethods(run, "tasks.update"))).toMatchObject({ method: "tasks.update", changes: true, params: { type: "object" } });
    // Every one of them can tell the Orcling what it takes.
    for (const method of [...methods.reads, ...methods.changes]) expect(JSON.parse(await host().appMethods(run, method)).params, method).toMatchObject({ type: "object" });

    const open = taskIn(project.id, "Ship the onboarding");
    const finished = taskIn(project.id, "Old work");
    tasks.update(core.db, finished.id, { status: "done" });
    const listed = JSON.parse(await host().app(run, "tasks.list", { projectId: project.id })) as { id: string; status: string }[];
    expect(listed.map((task) => task.id).sort()).toEqual([open.id, finished.id].sort());
    expect(JSON.parse(await host().app(run, "tasks.get", { id: open.id }))).toMatchObject({ title: "Ship the onboarding", spec: "The spec of Ship the onboarding." });

    // Pip is set to Allow and its chat runs Autonomous, so a change goes ahead without asking, and is on record as Pip's.
    await host().app(run, "tasks.update", { id: open.id, patch: { status: "review" } });
    expect(tasks.get(core.db, open.id)?.status).toBe("review");
    const acts = core.db.stmt("SELECT resource_id, metadata FROM audit_events WHERE action = 'orcling.act'").all() as { resource_id: string; metadata: string }[];
    expect(acts.map((entry) => ({ who: entry.resource_id, ...JSON.parse(entry.metadata) }))).toEqual([{ who: pip.id, runId: run, method: "tasks.update" }]);
  } finally {
    await core.close();
  }
});

it("leaves to the person what only they decide, refuses what OpenOrc does not offer, and asks first when its permission says so", async () => {
  const { core, idle, host, ready } = await fixture();
  try {
    createdDb = core.db;
    const { pip, run, project } = await ready();
    await expect(host().app(run, "orclings.update", { id: pip.id, draft: { ...draft("Pip"), permission: "approve" } })).resolves.toBeTruthy();
    await expect(host().app(run, "orclings.update", { id: pip.id, draft: { ...draft("Pip"), permission: "allow" } })).rejects.toThrow(/Only the person can let you work without asking/);
    await expect(host().app(run, "orclings.delete", { id: pip.id })).rejects.toThrow(/Only the person can delete you/);
    await expect(host().app(run, "projects.delete", { id: project.id })).rejects.toThrow(/not something you can do for the person/);
    await expect(host().app(run, "tasks.create", { projectId: project.id, title: "Bad\u202Etitle" })).rejects.toThrow();

    const careful = await core.orclings.create({ ...draft("Careful"), permission: "approve" });
    await core.threads.continueThread(careful.threadId, { agent: "codex", model: "fixture", effort: undefined, attachments: undefined, mode: "act", permissionMode: "review", prompt: "hi" });
    await idle(careful.threadId);
    const carefulRun = runs.listForThread(core.db, careful.threadId).at(-1)!.id;
    const task = taskIn(project.id, "Careful task");
    // Reading never asks.
    expect(JSON.parse(await host().app(carefulRun, "tasks.get", { id: task.id }))).toMatchObject({ id: task.id });
    const asking = host().app(carefulRun, "tasks.update", { id: task.id, patch: { status: "done" } });
    await vi.waitFor(() => expect(core.runs.pending().some((pending) => pending.runId === carefulRun)).toBe(true));
    const approval = core.runs.pending().find((pending) => pending.runId === carefulRun)!;
    expect(approval.detail).toMatch(/Careful wants to tasks\.update for you/);
    core.runs.resolveApproval(carefulRun, approval.approvalId, "deny");
    await expect(asking).rejects.toThrow();
    expect(tasks.get(core.db, task.id)?.status).not.toBe("done");
  } finally {
    await core.close();
  }
});

it("sees threads nested as the sidebar shows them, and starts work as a subthread of the one it names", async () => {
  const { core, idle, host, ready } = await fixture();
  try {
    const { run, project } = await ready();
    const turn = { agent: "codex" as const, model: "fixture", effort: undefined, attachments: undefined, mode: "act" as const, permissionMode: "autonomous" as const };
    const { thread: main } = await core.threads.start({ ...turn, prompt: "Build the page", projectId: project.id, title: "Build" });
    await idle(main.id);
    const { thread: tests } = await core.threads.startUnder(main.id, { ...turn, prompt: "please hold", title: "Tests" });
    await vi.waitFor(() => expect(core.threads.get(tests.id)?.activity).toBe("running"));

    const started = JSON.parse(await host().startWork(run, { under: main.id, prompt: "Write the docs", title: "Docs", worker: { kind: "agent" }, reportBack: false })) as {
      thread: { id: string };
      under: { id: string; title: string };
    };
    expect(started.under).toEqual({ id: main.id, title: "Build" });
    expect(threads.get(core.db, started.thread.id)).toMatchObject({ parentThreadId: main.id, projectId: project.id });
    await idle(started.thread.id);

    const glance = JSON.parse(await host().project(run, project.id, undefined)) as { threads: { title: string; subthreads?: { title: string; as: string; under?: unknown }[] }[] };
    const build = glance.threads.find((thread) => thread.title === "Build")!;
    expect(build.subthreads?.map(({ title, as, under }) => ({ title, as, under }))).toEqual(
      expect.arrayContaining([
        { title: "Tests", as: "subthread", under: undefined },
        { title: "Docs", as: "subthread", under: undefined },
      ]),
    );
    expect(glance.threads.map((thread) => thread.title)).not.toContain("Tests");

    const activity = JSON.parse(await host().activity(run)) as { threads: { title: string; under?: { id: string; title: string }; as?: string }[] };
    expect(activity.threads.find((thread) => thread.title === "Tests")).toMatchObject({ under: { id: main.id, title: "Build" }, as: "subthread" });
  } finally {
    await core.close();
  }
});

it("knows the person's Claude accounts: which each thread runs on, which a project uses, and its own", async () => {
  const { core, idle, host, ready } = await fixture();
  try {
    const work = claudeAccounts.add(core.db, "Work");
    const { run, project } = await ready();
    const started = JSON.parse(
      await host().startWork(run, { projectId: project.id, prompt: "Fix it", title: "Fix", worker: { kind: "agent", agent: "claude", claudeAccount: "Work" }, reportBack: false }),
    ) as {
      thread: { id: string };
    };
    expect(threads.get(core.db, started.thread.id)?.claudeAccountId).toBe(work.id);
    await idle(started.thread.id);

    const glance = JSON.parse(await host().project(run, project.id, undefined)) as {
      claudeAccounts: { uses: string[]; newThreadsOn: string | null; switchesWhenLimited: boolean };
      threads: { title: string; claudeAccount?: string }[];
    };
    expect(glance.threads.find((thread) => thread.title === "Fix")?.claudeAccount).toBe("Work");
    expect(glance.claudeAccounts.uses).toContain("Work");
    expect(glance.claudeAccounts.newThreadsOn).not.toBeNull();

    const models = JSON.parse(await host().models(run, undefined)) as { claudeAccounts: { name: string; default?: true }[]; you: { agent: string; model: string } };
    expect(models.claudeAccounts.map((account) => account.name)).toContain("Work");
    expect(models.claudeAccounts.filter((account) => account.default)).toHaveLength(1);
    expect(models.you).toMatchObject({ agent: "codex", model: "fixture" });
  } finally {
    await core.close();
  }
});

it("tells a thread its message came from the person's Orcling and to answer in its own thread, and puts new work where it is asked", async () => {
  const { core, heard, idle, host, ready } = await fixture();
  try {
    createdDb = core.db;
    const { run, project } = await ready();
    const turn = { agent: "codex" as const, model: "fixture", effort: undefined, attachments: undefined, mode: "act" as const, permissionMode: "autonomous" as const };
    const { thread: theirs } = await core.threads.start({ ...turn, prompt: "Build it", projectId: project.id, title: "Build" });
    await idle(theirs.id);
    expect(JSON.parse(await host().sendThread(run, { threadId: theirs.id, text: "How is it going?", reportBack: false }))).toMatchObject({ delivered: true });
    await vi.waitFor(() =>
      expect(heard.filter((entry) => entry.threadId === theirs.id).at(-1)?.input).toBe(
        "Message from Pip, the person's Orcling. It reads your replies in this thread and can't be messaged back, so answer here:\n\nHow is it going?",
      ),
    );
    await idle(theirs.id);

    const onCheckout = JSON.parse(await host().startWork(run, { projectId: project.id, prompt: "Tidy", worker: { kind: "agent" }, worktree: false, reportBack: false })) as { thread: { id: string } };
    expect(threads.get(core.db, onCheckout.thread.id)?.workspaceMode).toBe("current");
    await idle(onCheckout.thread.id);
    await expect(host().startWork(run, { under: theirs.id, prompt: "Help", worker: { kind: "agent" }, worktree: true, reportBack: false })).rejects.toThrow(/A subthread works in its parent's folder/);
    const task = taskIn(project.id, "Saved");
    await expect(host().startWork(run, { projectId: project.id, taskId: task.id, prompt: "Go", worker: { kind: "agent" }, worktree: true, reportBack: false })).rejects.toThrow(
      /A task works where its task says/,
    );
  } finally {
    await core.close();
  }
});

it("keeps a large catalog short, finds any model by search, and says why new work starts where it does when no default is set", async () => {
  const { core, host, ready } = await fixture();
  try {
    const { run } = await ready();
    const providers = ["OpenRouter", "Zen", "Groq"];
    const big = Array.from({ length: 385 }, (_, index) =>
      option("opencode", `${providers[index % 3]!.toLowerCase()}/model-${index}`, `Model ${index}`, { provider: { id: providers[index % 3]!, label: providers[index % 3]! }, isDefault: index === 7 }),
    );
    vi.mocked(core.runs.models).mockImplementation(async (agent) => (agent === "opencode" ? big : (CATALOG[agent!] ?? [])));
    vi.mocked(core.settings.enabledHarnesses).mockReturnValue(["claude", "codex", "opencode"]);
    vi.mocked(core.settings.get).mockReturnValue({ ...vi.mocked(core.settings.get).getMockImplementation()!(), defaultHarness: null });

    const text = await host().models(run, undefined);
    // Short enough for any tool result, however many models the agents offer.
    expect(text.length).toBeLessThan(6000);
    const all = JSON.parse(text) as {
      newThreadsStartOn: { agent: string; why: string };
      agents: { agent: string; count: number; suggested?: { id: string; note: string }[]; providers?: { provider: string; models: number }[] }[];
    };
    // No default in Settings: the agent the person ran their own work on (the Orcling's chat runs don't count, and there are none of theirs yet).
    expect(all.newThreadsStartOn.agent).toBe("claude");
    expect(all.newThreadsStartOn.why).toMatch(/No default is set in Settings/);
    const opencode = all.agents.find((entry) => entry.agent === "opencode")!;
    expect(opencode).toMatchObject({
      count: 385,
      providers: [
        { provider: "OpenRouter", models: 129 },
        { provider: "Zen", models: 128 },
        { provider: "Groq", models: 128 },
      ],
    });
    expect(opencode.suggested).toEqual([expect.objectContaining({ id: "zen/model-7", note: "The agent's default" })]);

    const found = JSON.parse(await host().models(run, "opencode", "zen model-10")) as { agents: { matches: { id: string }[] }[] };
    expect(found.agents[0]!.matches.map((model) => model.id)).toEqual(["zen/model-10", "zen/model-100", "zen/model-103", "zen/model-106", "zen/model-109"]);
  } finally {
    await core.close();
  }
});

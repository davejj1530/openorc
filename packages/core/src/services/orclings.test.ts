import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { memories, projects, runs, settings, summaries, tasks, threads } from "@openorc/db";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { WORKSPACE_ID, defaultOrclingLook, orclingExecution, type OrclingDraft, type RunSpec } from "@openorc/protocol";
import { createOrclingHost } from "../mcp-host/orcling.js";
import { OpenOrc } from "../openorc.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const draft = (overrides: Partial<OrclingDraft> = {}): OrclingDraft => ({
  name: "Gloop",
  look: defaultOrclingLook,
  settings: { agent: "codex", model: "fixture", effort: null, fastMode: false },
  permission: "allow",
  ...overrides,
});
const turn = { agent: "codex" as const, model: "fixture", effort: undefined, attachments: undefined };

/** A core whose Codex runs answer at once, recording what each launch was given. */
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "openorc-orclings-"));
  const specs: RunSpec[] = [];
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    const handle = new RunHandle(spec.runId, { send: async () => {}, interrupt() {}, close: () => finish(0), done });
    specs.push(spec);
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: `session-${specs.length}`, model: "fixture" });
      handle.emit("event", { type: "message.completed", runId: spec.runId, ts: Date.now(), messageId: `reply-${specs.length}`, role: "assistant", text: `Reply ${specs.length}` });
      handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: "turn", status: "success", durationMs: 1 });
    }, 0);
    return handle;
  });
  const core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} } });
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  const idle = (threadId: string) => vi.waitFor(() => expect(core.threads.get(threadId)?.activity).toBe("idle"));
  return { core, specs, idle };
}

it("gives a new Orcling its own Workspace conversation, starter instructions and its identity in every launch", async () => {
  const { core, specs, idle } = await fixture();
  try {
    const gloop = await core.orclings.create(draft());
    const home = threads.get(core.db, gloop.threadId)!;
    expect(home).toMatchObject({ projectId: WORKSPACE_ID, orclingId: gloop.id, title: "Gloop", mode: "act", permissionMode: "autonomous" });
    expect(core.orclings.instructions(gloop.id)).toMatchObject([{ version: 1, author: "user" }]);

    await core.threads.continueThread(home.id, { ...turn, mode: "act", permissionMode: "autonomous", prompt: "Hi" });
    await idle(home.id);
    expect(specs[0]!.systemPromptAppendix).toContain("# You are Gloop");
    expect(specs[0]!.systemPromptAppendix).toContain("This is your own conversation with the person");
    expect(specs[0]!.systemPromptAppendix).toContain("Be warm, direct and brief.");
    expect(runs.listForThread(core.db, home.id).at(-1)!.orclingId).toBe(gloop.id);

    core.orclings.saveInstructions(gloop.id, "Answer in haiku.", "orcling", "They asked for poems");
    expect(core.orclings.restoreInstructions(gloop.id, 1)).toMatchObject({ version: 3, author: "user", note: "Restored version 1" });
  } finally {
    await core.close();
  }
});

it("resumes its own conversation until it has been quiet for hours, then starts a fresh session from a summary", async () => {
  const { core, specs, idle } = await fixture();
  try {
    const gloop = await core.orclings.create(draft());
    const send = async (prompt: string) => {
      await core.threads.continueThread(gloop.threadId, { ...turn, mode: "act", permissionMode: "autonomous", prompt });
      await idle(gloop.threadId);
    };
    await send("Remember that I jog on Mondays");
    await send("What did I say?");
    expect(specs[1]!.resumeSessionId).toBe("session-1");

    core.db.stmt("UPDATE events SET ts = ts - ? WHERE run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(7 * 60 * 60 * 1000, gloop.threadId);
    await send("Good morning");
    expect(specs[2]!.resumeSessionId).toBeUndefined();
    expect(specs[2]!.systemPromptAppendix).toContain("Your conversation continues in a new session.");
    expect(specs[2]!.systemPromptAppendix).toContain("The person: Remember that I jog on Mondays");
  } finally {
    await core.close();
  }
});

it("keeps an Orcling's files in a folder named after it, moves them when it is renamed, and refuses a name another Orcling has", async () => {
  const { core, specs, idle } = await fixture();
  try {
    const rini = await core.orclings.create(draft({ name: "Rini" }));
    const folder = () => threads.get(core.db, rini.threadId)!.workingDirectory!;
    const send = async (prompt: string, workingDirectory?: string) => {
      await core.threads.continueThread(rini.threadId, { ...turn, mode: "act", permissionMode: "autonomous", prompt, ...(workingDirectory ? { workingDirectory } : {}) });
      await idle(rini.threadId);
    };
    expect(basename(folder())).toBe("rini");
    await expect(core.orclings.create(draft({ name: "rini!" }))).rejects.toThrow("You already have an Orcling named Rini.");

    await send("Keep notes here");
    await writeFile(join(folder(), "notes.md"), "Jog on Mondays");
    await core.orclings.update(rini.id, draft({ name: "Rina" }));
    expect(basename(folder())).toBe("rina");
    expect(await readFile(join(folder(), "notes.md"), "utf8")).toBe("Jog on Mondays");

    // Its session began in the old folder, so the next turn starts a fresh one there from a summary.
    await send("Where are my notes?");
    expect(specs.at(-1)!.cwd).toBe(folder());
    expect(specs.at(-1)!.resumeSessionId).toBeUndefined();
    expect(specs.at(-1)!.systemPromptAppendix).toContain("Your conversation continues in a new session.");

    // A folder the person chose stays where it is, and deleting the Orcling leaves the files it made.
    const chosen = await realpath(await mkdtemp(join(root!, "chosen-")));
    await send("Work in my folder", chosen);
    await core.orclings.update(rini.id, draft({ name: "Rona" }));
    expect(folder()).toBe(chosen);
    const desk = join(root!, "data", "orclings", "rina");
    await core.orclings.delete(rini.id);
    expect(await readFile(join(desk, "notes.md"), "utf8")).toBe("Jog on Mondays");
  } finally {
    await core.close();
  }
});

it("keeps its own conversation a private chat: no Workspace memory in its prompt, none of it in the Workspace's, and the Workspace one lookup away", async () => {
  const { core, specs, idle } = await fixture();
  try {
    settings.set(core.db, "memory.enabled", "true");
    const workspace = projects.get(core.db, WORKSPACE_ID)!;
    const { thread: other } = await core.threads.start({ ...turn, mode: "act", permissionMode: "autonomous", prompt: "Fix her audit query", projectId: WORKSPACE_ID, title: "Audit" });
    await idle(other.id);
    const summary = (runId: string, threadId: string, open: string) =>
      summaries.upsert(core.db, { runId, taskId: null, threadId, projectId: WORKSPACE_ID, request: "", workDone: "", outcome: "", openItems: [open], model: null });
    summary(runs.listForThread(core.db, other.id)[0]!.id, other.id, "Fiancée runs the diagnostic");
    core.memory.record({ projectId: WORKSPACE_ID, type: "convention", title: "Shipnet audit query", body: "Join the login tables.", source: "user" });

    const rini = await core.orclings.create(draft({ name: "Rini" }));
    await core.threads.continueThread(rini.threadId, { ...turn, mode: "act", permissionMode: "autonomous", prompt: "Hi" });
    await idle(rini.threadId);
    const prompt = specs.at(-1)!.systemPromptAppendix!;
    expect(prompt).toContain("# You are Rini");
    expect(prompt).toContain("your own folder for notes and files");
    for (const borrowed of ["# Project memory", "Fiancée runs the diagnostic", "Shipnet audit query", "Tasks are records of work"]) expect(prompt).not.toContain(borrowed);

    const home = runs.listForThread(core.db, rini.threadId).at(-1)!.id;
    summary(home, rini.threadId, "Rini's own open item");
    expect(core.memory.brief(workspace)).toContain("Fiancée runs the diagnostic");
    expect(core.memory.brief(workspace)).not.toContain("Rini's own open item");

    const tools = createOrclingHost({
      db: core.db,
      orclings: core.orclings,
      memory: core.memory,
      runs: core.runs,
      threads: core.threads,
      settings: core.settings,
      send: async () => {
        throw new Error("Not sent in this test.");
      },
      invalidate: () => {},
    }).orcling!;
    expect(tools.ownConversation(home)).toBe(true);
    expect(tools.ownConversation(runs.listForThread(core.db, other.id)[0]!.id)).toBe(false);
    expect(JSON.parse(await tools.projects(home))[0]).toMatchObject({ id: WORKSPACE_ID, name: workspace.name });
    const glance = JSON.parse(await tools.project(home, WORKSPACE_ID, undefined)) as { threads: { id: string }[]; memory: string };
    expect(glance.threads.map((thread) => thread.id)).toEqual([other.id]);
    expect(glance.memory).toContain("Shipnet audit query");
  } finally {
    await core.close();
  }
});

/** Calls a tool on a run's MCP endpoint and returns its text, and whether it failed. */
async function toolCall(url: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await response.text();
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  );
  return payload.error ? { isError: true, text: String(payload.error.message) } : { isError: payload.result.isError === true, text: payload.result.content[0].text };
}

it("starts work in a project as itself, from a prompt or a saved task, and asks first when its permission says so", async () => {
  const { core, specs, idle } = await fixture();
  try {
    const project = projects.insert(core.db, { name: "Site", rootPath: root!, gitRemote: null, defaultBranch: null, settings: {} });
    const gloop = await core.orclings.create(draft());
    await core.threads.continueThread(gloop.threadId, { ...turn, mode: "act", permissionMode: "autonomous", prompt: "Hi" });
    await idle(gloop.threadId);
    const url = (await core.mcpServer()).urlForRun(runs.listForThread(core.db, gloop.threadId).at(-1)!.id);

    const fresh = await toolCall(url, "orcling_thread_start", { project_id: project.id, prompt: "Build the landing page", title: "Landing page" });
    const started = JSON.parse(fresh.text) as { thread: { id: string } };
    expect(threads.get(core.db, started.thread.id)).toMatchObject({ projectId: project.id, orclingId: gloop.id, title: "Landing page" });
    await idle(started.thread.id);
    expect(specs.at(-1)!.systemPromptAppendix).toContain("# You are Gloop");
    // It opens with a notice naming who started it, not as words the person typed.
    const opening = core.db
      .stmt("SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.thread_id = ? AND e.kind = 'message.completed' ORDER BY e.seq LIMIT 1")
      .get(started.thread.id) as { payload: string };
    expect(JSON.parse(opening.payload)).toMatchObject({ role: "system", text: expect.stringMatching(/^Gloop started this thread\.\n\nBuild the landing page/) });

    const task = tasks.insert(core.db, {
      projectId: project.id,
      title: "Add a contact form",
      spec: "A name and an email.",
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: null,
      parentTaskId: null,
      threadId: null,
    });
    const takenUp = JSON.parse((await toolCall(url, "orcling_thread_start", { project_id: project.id, task_id: task.id, prompt: "Start on this now" })).text) as {
      task: { id: string };
      thread: { id: string };
    };
    expect(takenUp.task.id).toBe(task.id);
    expect(threads.get(core.db, takenUp.thread.id)?.orclingId).toBe(gloop.id);
    expect(tasks.get(core.db, task.id)?.status).toBe("in_progress");
    await idle(takenUp.thread.id);
    expect(specs.at(-1)!.prompt).toContain("Add a contact form");

    const { thread: theirs } = await core.threads.start({ ...turn, mode: "act", permissionMode: "autonomous", prompt: "Make a task", projectId: project.id, title: "Theirs" });
    await idle(theirs.id);
    const owned = tasks.insert(core.db, {
      projectId: project.id,
      title: "Owned",
      spec: null,
      priority: "none",
      labels: [],
      workspaceMode: "current",
      baseRef: null,
      parentTaskId: null,
      threadId: theirs.id,
    });
    expect((await toolCall(url, "orcling_thread_start", { project_id: project.id, task_id: owned.id, prompt: "Take it" })).text).toMatch(/already has a conversation, "Theirs"/);
    expect((await toolCall(url, "orcling_thread_start", { project_id: WORKSPACE_ID, prompt: "Anything" })).text).toMatch(/Start work in a project/);

    // An Approve Orcling asks first; declining starts nothing.
    const careful = await core.orclings.create(draft({ name: "Careful", permission: "approve" }));
    await core.threads.continueThread(careful.threadId, { ...turn, mode: "act", permissionMode: "review", prompt: "Hi" });
    await idle(careful.threadId);
    const carefulRun = runs.listForThread(core.db, careful.threadId).at(-1)!.id;
    const asking = toolCall((await core.mcpServer()).urlForRun(carefulRun), "orcling_thread_start", { project_id: project.id, prompt: "Refactor everything" });
    await vi.waitFor(() => expect(core.runs.pending().some((approval) => approval.runId === carefulRun)).toBe(true));
    const approval = core.runs.pending().find((pending) => pending.runId === carefulRun)!;
    core.runs.resolveApproval(carefulRun, approval.approvalId, "deny");
    expect((await asking).isError).toBe(true);
    expect(threads.list(core.db, { projectId: project.id }).filter((thread) => thread.orclingId === careful.id)).toEqual([]);
  } finally {
    await core.close();
  }
});

it("answers as a guest in another agent's thread, and the thread's agent hears the answer on its own session", async () => {
  const { core, specs, idle } = await fixture();
  try {
    const project = projects.insert(core.db, { name: "Site", rootPath: root!, gitRemote: null, defaultBranch: null, settings: {} });
    const gloop = await core.orclings.create(draft());
    const { thread } = await core.threads.start({ ...turn, mode: "act", permissionMode: "autonomous", prompt: "Build the page", projectId: project.id, title: "Page" });
    await idle(thread.id);

    await core.orclings.ask(gloop.id, thread.id, "@Gloop what do you think?", undefined);
    await idle(thread.id);
    expect(specs[1]!.systemPromptAppendix).toContain("The person mentioned you in a conversation that belongs to another agent.");
    expect(specs[1]!.systemPromptAppendix).toContain("This conversation began before you joined.");
    expect(runs.listForThread(core.db, thread.id).at(-1)!.orclingId).toBe(gloop.id);
    expect(threads.get(core.db, thread.id)!.orclingId).toBeNull();

    await core.threads.continueThread(thread.id, { ...turn, mode: "act", permissionMode: "autonomous", prompt: "Carry on" });
    await idle(thread.id);
    expect(specs[2]!.resumeSessionId).toBe("session-1");
    expect(specs[2]!.systemPromptAppendix).toContain("Since your last turn in this conversation, others spoke here");
    expect(specs[2]!.systemPromptAppendix).toContain("Gloop: Reply 2");
    expect(specs[2]!.systemPromptAppendix).not.toContain("# You are Gloop");
  } finally {
    await core.close();
  }
});

it("never lets a conversation work more freely than the Orcling in it allows", async () => {
  const { core, specs, idle } = await fixture();
  try {
    const project = projects.insert(core.db, { name: "Site", rootPath: root!, gitRemote: null, defaultBranch: null, settings: {} });
    const careful = await core.orclings.create(draft({ name: "Careful", permission: "approve" }));
    const { thread } = await core.threads.start({ ...turn, mode: "act", permissionMode: "autonomous", prompt: "Hello", projectId: project.id, title: "Page" });
    await idle(thread.id);

    core.orclings.assign(thread.id, careful.id);
    expect(threads.get(core.db, thread.id)).toMatchObject({ orclingId: careful.id, permissionMode: "review" });
    expect(core.orclings.threadPatch(thread.id, { permissionMode: "autonomous" })).toEqual({ permissionMode: "review" });

    await core.threads.continueThread(thread.id, { ...turn, mode: "act", permissionMode: "autonomous", prompt: "Deploy it" });
    await idle(thread.id);
    expect(specs.at(-1)).toMatchObject({ permissionMode: "review" });
    expect(specs.at(-1)!.systemPromptAppendix).toContain("The person chose you to work in this conversation.");

    await expect(core.orclings.startThread(careful.id, { projectId: WORKSPACE_ID, mode: "act", permissionMode: "autonomous", prompt: "Hi", attachments: undefined, title: undefined })).rejects.toThrow(
      /its own conversation/,
    );
  } finally {
    await core.close();
  }
});

it("lets an OpenCode Orcling change things when allowed, and keeps it read-only on Approve since OpenCode cannot ask first", () => {
  const settings = { agent: "opencode" as const, model: "fixture", effort: null, fastMode: false };
  expect(orclingExecution({ permission: "allow", settings })).toEqual({ mode: "act", permissionMode: "autonomous" });
  expect(orclingExecution({ permission: "approve", settings })).toEqual({ mode: "plan", permissionMode: "review" });
  expect(orclingExecution({ permission: "approve", settings: { ...settings, agent: "claude" } })).toEqual({ mode: "act", permissionMode: "review" });
});

it("keeps an Orcling's memories apart from projects and removes them with it", async () => {
  const { core } = await fixture();
  try {
    settings.set(core.db, "memory.enabled", "true");
    const gloop = await core.orclings.create(draft());
    const memory = core.memory.record({ projectId: null, orclingId: gloop.id, type: "preference", title: "Jogs on Mondays", body: "They run every Monday morning.", source: "agent" });
    expect(memory).toMatchObject({ scope: "orcling", projectId: null, orclingId: gloop.id });
    expect(memories.list(core.db, { projectId: WORKSPACE_ID }).map((m) => m.id)).not.toContain(memory.id);
    expect(memories.search(core.db, "Mondays", WORKSPACE_ID)).toEqual([]);
    expect(memories.searchOrcling(core.db, "Mondays", gloop.id).map((hit) => hit.memory.id)).toEqual([memory.id]);
    expect(core.memory.orclingBrief(gloop.id)).toContain("Jogs on Mondays");

    await expect(core.orclings.create(draft({ name: "gloop" }))).rejects.toThrow(/already have an Orcling named Gloop/);
    await core.orclings.delete(gloop.id);
    expect(core.orclings.list()).toEqual([]);
    expect(memories.get(core.db, memory.id)).toBeNull();
    expect(threads.get(core.db, gloop.threadId)).toBeNull();
  } finally {
    await core.close();
  }
});

import { claudeAccounts, messages, orclingFollowups, projects, runs, tasks, threads, type Db } from "@openorc/db";
import { STAY_QUIET } from "../services/orcling-quiet.js";
import type { McpHost, OrclingStartInput, OrclingTools } from "@openorc/mcp";
import {
  executionMode,
  executionModeLabel,
  executionModeSettings,
  orclingExecution,
  reactionEmoji,
  WORKSPACE_ID,
  type ExecutionMode,
  type MemoryType,
  type Orcling,
  type Project,
  type Task,
  type TaskStatus,
  type Thread,
  type WorkspaceMode,
} from "@openorc/protocol";
import { latestPersonMessage } from "../services/orcling-reactions.js";
import type { MemoryService } from "../services/memory.js";
import type { OrclingService } from "../services/orclings.js";
import type { RunService } from "../services/runs.js";
import type { ThreadService } from "../services/threads.js";
import { describeWork, workAccess, workSettings, type WorkCatalog, type WorkSettings } from "../services/orcling-work.js";
import { appTools, type AppDependencies } from "./orcling-app.js";
import { accountNames, orclingChatIds, overviewTools, threadTree, type OverviewDependencies } from "./orcling-overview.js";
import { projectAccountPolicy } from "../services/project-claude-accounts.js";

type Dependencies = OverviewDependencies &
  Omit<AppDependencies, "db" | "runs"> & {
    orclings: Pick<OrclingService, "forRun" | "saveInstructions" | "startThread" | "startTask" | "react" | "talk">;
    memory: Pick<MemoryService, "assertEnabled" | "record" | "retrieveOrcling" | "retrieve" | "brief">;
    runs: Pick<RunService, "authorizeAppAction">;
    threads: Pick<ThreadService, "toolThreadRead">;
    send: NonNullable<McpHost["threads"]>["send"];
    invalidate: (keys: string[]) => void;
  };

type Speaker = (runId: string) => Orcling;

const OPEN: TaskStatus[] = ["proposed", "backlog", "in_progress", "review"];
const json = (value: unknown) => JSON.stringify(value);
const age = (ts: number) => `${Math.max(0, Math.round((Date.now() - ts) / 86_400_000))}d ago`;

/** The tools an Orcling carries everywhere: its instructions, its memory, its past conversations and the person's projects. */
export function createOrclingHost(deps: Dependencies): Pick<McpHost, "orcling"> {
  const speaker: Speaker = (runId) => {
    const orcling = deps.orclings.forRun(runId);
    if (!orcling) throw new Error("Only an Orcling has these tools.");
    return orcling;
  };
  return {
    orcling: {
      available: (runId) => {
        const run = runs.get(deps.db, runId);
        return Boolean(run?.orclingId && !run.commentTurnId && deps.orclings.forRun(runId));
      },
      ownConversation: (runId) => {
        const run = runs.get(deps.db, runId);
        return Boolean(run?.threadId && run.threadId === deps.orclings.forRun(runId)?.threadId);
      },
      ...selfTools(deps, speaker),
      ...projectTools(deps, speaker),
      ...talkTools(deps, speaker),
      ...overviewTools(deps, speaker),
      ...appTools(deps, speaker),
    },
  };
}

/** Its instructions, its memory, what it said before, and its reactions in its own conversation. */
function selfTools(deps: Dependencies, speaker: Speaker): Pick<OrclingTools, "updateInstructions" | "remember" | "recall" | "history" | "react"> {
  return {
    react: async (runId, reaction) => {
      const self = speaker(runId);
      const target = latestPersonMessage(deps.db, self.threadId);
      if (!target) return "The person has not written anything to react to yet.";
      deps.orclings.react({ threadId: self.threadId, runId: target.runId, messageId: target.messageId, part: 0 }, reaction, self.id);
      const quoted = target.text.replace(/\s+/g, " ").trim().slice(0, 80);
      return `Reacted ${reactionEmoji[reaction]} to "${quoted}". If that says it all, ${STAY_QUIET}.`;
    },
    updateInstructions: async (runId, { body, reason }) => {
      const self = speaker(runId);
      await deps.runs.authorizeAppAction(runId, "orcling_instructions", {
        toolName: "orcling_instructions_update",
        reason: `${self.name} wants to rewrite its instructions: ${reason}`,
        input: { body, reason },
      });
      const saved = deps.orclings.saveInstructions(self.id, body, "orcling", reason);
      return `Saved as version ${saved.version}. They apply from your next session. Tell the person what you changed.`;
    },
    remember: async (runId, entry) => {
      const self = speaker(runId);
      deps.memory.assertEnabled();
      await deps.runs.authorizeAppAction(runId, "memory_write", { toolName: "orcling_remember", reason: `${self.name} wants to remember: ${entry.title}`, input: entry });
      const memory = deps.memory.record({
        projectId: null,
        orclingId: self.id,
        type: entry.type as MemoryType,
        title: entry.title,
        body: entry.body,
        topicKey: entry.topicKey ?? null,
        source: "agent",
        sourceRunId: runId,
      });
      return json({ id: memory.id, remembered: true });
    },
    recall: async (runId, query, limit) => {
      const hits = await deps.memory.retrieveOrcling(speaker(runId).id, query, limit);
      if (!hits.length) return "Nothing in your memory matches that.";
      return json(hits.map(({ memory }) => ({ id: memory.id, type: memory.type, title: memory.title, body: memory.body, saved: age(memory.lastConfirmedAt) })));
    },
    history: async (runId, query, limit) => {
      const hits = messages.search(deps.db, query, { orclingId: speaker(runId).id, limit });
      if (!hits.length) return "Nothing said in your conversations matches that.";
      return json(hits.map((hit) => ({ thread: hit.threadTitle, threadId: hit.threadId, who: hit.role === "user" ? "the person" : "reply", said: hit.snippet, when: new Date(hit.ts).toISOString() })));
    },
  };
}

/** What an Orcling's new work is: a saved task of the project when one is named, and a short name for it. */
function workTarget(db: Db, place: Project, input: { taskId?: string; title?: string; prompt: string }) {
  if (place.id === WORKSPACE_ID) throw new Error("Start work in a project. In the Workspace, you work in your own conversation.");
  const task = input.taskId ? tasks.get(db, input.taskId) : null;
  if (input.taskId && task?.projectId !== place.id) throw new Error("No such task in that project. orcling_project lists its open tasks.");
  return { task, what: task?.title ?? input.title ?? input.prompt.split("\n")[0]!.slice(0, 120) };
}

/** New work opens with a notice saying who started it, rather than words the person did not type. */
function startSettings(opener: string, prompt: string) {
  return { prompt: `${opener}\n\n${prompt}`, promptRole: "system" as const };
}

/** Which Claude accounts a project's threads may use, which one new threads start on, and whether a limit moves them on. */
function projectAccounts(db: Db, projectId: string) {
  if (!claudeAccounts.list(db).some((account) => account.enabled)) return {};
  const policy = projectAccountPolicy(db, projectId);
  const name = accountNames(db);
  return { claudeAccounts: { uses: policy.allowed.map((id) => name(id) ?? id), newThreadsOn: name(policy.defaultId) ?? null, switchesWhenLimited: policy.autoSwitch } };
}

/** Every place the person works: their Workspace, then their projects. */
function places(db: Db): Project[] {
  const workspace = projects.get(db, WORKSPACE_ID);
  return [...(workspace ? [workspace] : []), ...projects.list(db)];
}

/** What the person can start work on: the agents they turned on, the one new threads start on, and each one's models. */
function catalog(deps: Dependencies): WorkCatalog {
  return {
    enabled: () => deps.settings.enabledHarnesses(),
    defaultAgent: () => deps.settings.get().defaultHarness,
    models: (agent, claudeAccountId) => deps.runs.models(agent, undefined, undefined, claudeAccountId),
  };
}

function placeById(db: Db, id: string): Project {
  const found = places(db).find((candidate) => candidate.id === id);
  if (!found) throw new Error(id ? "No such project. Call orcling_projects for the ids." : "Name a project_id, or a thread to start under.");
  return found;
}

/** What work an Orcling starts runs on and how freely, chosen before the person is asked, so a refusal comes first. */
async function planWork(deps: Dependencies, runId: string, self: Orcling, input: OrclingStartInput) {
  const on = input.worker.kind === "agent" ? await workSettings(deps.db, catalog(deps), input.worker) : undefined;
  const from = threads.get(deps.db, runs.get(deps.db, runId)?.threadId ?? "");
  const ceiling = orclingExecution(self);
  const access = workAccess({
    asked: input.access,
    conversation: executionMode(from?.mode ?? "act", from?.permissionMode ?? "review"),
    ceiling: executionMode(ceiling.mode, ceiling.permissionMode),
    orcling: self.name,
    agent: on?.agent ?? self.settings.agent,
  });
  const model = on ? describeWork(on, await deps.runs.models(on.agent)) : `${self.name}, on its own model`;
  return { on, access, runsOn: input.access ? `${model}, ${executionModeLabel[access]}` : model };
}

/** Work an Orcling starts in a project for the person: a new thread, or a saved task taken up, on what was chosen. */
/** Where work goes: a project, or under a thread, in that thread's project. */
function workPlace(db: Db, input: OrclingStartInput): { parent: Thread | null; target: Project } {
  const parent = input.under ? threads.get(db, input.under) : null;
  if (input.under && !parent) throw new Error("No such thread to start under. orcling_project and orcling_activity list them.");
  if (parent && input.taskId) throw new Error("A task's thread starts on its own, not under another thread.");
  if (input.worktree !== undefined && (parent || input.taskId)) throw new Error(parent ? "A subthread works in its parent's folder." : "A task works where its task says.");
  if (parent && input.projectId && input.projectId !== parent.projectId) throw new Error("That thread is in another project. Leave project_id out to start under it.");
  return { parent, target: placeById(db, parent?.projectId ?? input.projectId ?? "") };
}

/** Work an Orcling starts in a project for the person: a new thread, a subthread, or a saved task taken up, on what was chosen. */
async function startWork(deps: Dependencies, runId: string, self: Orcling, input: OrclingStartInput): Promise<string> {
  const { parent, target } = workPlace(deps.db, input);
  const { task, what } = workTarget(deps.db, target, input);
  const plan = await planWork(deps, runId, self, input);
  await deps.runs.authorizeAppAction(runId, "work_start", { toolName: "orcling_thread_start", reason: `${self.name} wants to start work in ${target.name} on ${plan.runsOn}: ${what}`, input });
  const threadId = await launchWork(deps, self, { input, parent, target, task, what, ...plan });
  const thread = threads.get(deps.db, threadId ?? "");
  deps.invalidate(["threads", "tasks"]);
  return json({
    ...(task ? { task: { id: task.id, title: task.title } } : {}),
    thread: { id: thread?.id ?? threadId, title: thread?.title ?? what },
    project: target.name,
    ...(parent ? { under: { id: parent.id, title: parent.title } } : {}),
    runsOn: plan.runsOn,
    access: executionModeLabel[thread ? executionMode(thread.mode, thread.permissionMode) : plan.access],
    ...(input.reportBack ? { reportBack: "You'll hear once when its turn ends." } : {}),
  });
}

const workspaceFor = (worktree: boolean): WorkspaceMode => (worktree ? "worktree" : "current");

/** Starts the work, opening with a notice of who started it: a task taken up, or a thread in its place. */
async function launchWork(
  deps: Dependencies,
  self: Orcling,
  work: { input: OrclingStartInput; parent: Thread | null; target: Project; task: Task | null; what: string; on: WorkSettings | undefined; access: ExecutionMode },
): Promise<string | null> {
  const { input, parent, target, task, what, on } = work;
  const kind = task ? "task" : "thread";
  const settings = {
    ...startSettings(
      on
        ? `${self.name}, the person's Orcling, started this ${kind} for them. It reads your replies here and may message you; answer in this thread, since it can't be messaged back.`
        : `${self.name} started this ${kind}.`,
      input.prompt,
    ),
    ...executionModeSettings(work.access),
  };
  const options = { ...(on ? { on } : {}), ...(parent ? { under: parent.id } : {}), followUp: input.reportBack };
  if (task) return (await deps.orclings.startTask(self.id, task.id, settings, options)).threadId;
  const workspaceMode = input.worktree === undefined ? deps.settings.get().defaultWorkspaceMode : workspaceFor(input.worktree);
  const thread = { ...settings, projectId: target.id, title: input.title ?? what, attachments: undefined, workspaceMode };
  return (await deps.orclings.startThread(self.id, thread, options)).thread.id;
}

/** The person's projects and Workspace: what is happening in them, and handing them work. */
function projectTools(deps: Dependencies, speaker: Speaker): Pick<OrclingTools, "projects" | "project" | "readThread" | "createTask" | "startWork" | "sendThread"> {
  const { db } = deps;
  const project = (id: string) => placeById(db, id);
  return {
    projects: async (runId) => {
      speaker(runId);
      return json(places(db).map((p) => ({ id: p.id, name: p.name, folder: p.rootPath, openTasks: tasks.list(db, { projectId: p.id, statuses: OPEN }).length })));
    },
    project: async (runId, projectId, query) => {
      speaker(runId);
      const found = project(projectId);
      const open = tasks
        .list(db, { projectId, statuses: OPEN })
        .slice(0, 20)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));
      // Orclings' own conversations sit in the Workspace but are private chats, not its work.
      const chats = orclingChatIds(db);
      const listed = deps.threads.list({ projectIds: [projectId], filter: "active", orderBy: "activity", limit: 10, includeChildren: true }).filter((t) => !chats.has(t.id));
      const recent = threadTree(listed, (id) => listed.find((t) => t.id === id)?.title ?? threads.get(db, id)?.title, accountNames(db));
      const memory = query ? (await deps.memory.retrieve(projectId, query, 8)).map(({ memory: m }) => ({ title: m.title, body: m.body })) : deps.memory.brief(found);
      return json({ project: { id: found.id, name: found.name, folder: found.rootPath }, ...projectAccounts(db, projectId), openTasks: open, threads: recent, memory });
    },
    readThread: async (runId, threadId, limit) => {
      speaker(runId);
      return json((await deps.threads.toolThreadRead(runId, threadId, limit)) ?? { error: "No such thread." });
    },
    createTask: async (runId, input) => {
      const self = speaker(runId);
      const target = project(input.projectId);
      const title = input.title.trim();
      const duplicate = tasks.list(db, { projectId: target.id, statuses: OPEN }).find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
      if (duplicate) return json({ task: { id: duplicate.id, title: duplicate.title, status: duplicate.status }, duplicate: true });
      const task = tasks.insert(db, {
        projectId: target.id,
        title,
        spec: input.spec || null,
        priority: "none",
        labels: [],
        workspaceMode: deps.settings.get().defaultWorkspaceMode,
        baseRef: target.defaultBranch,
        parentTaskId: null,
        threadId: null,
        origin: "agent",
      });
      deps.invalidate(["tasks"]);
      return json({ task: { id: task.id, title: task.title, status: task.status }, project: target.name, savedBy: self.name, duplicate: false });
    },
    startWork: (runId, input) => startWork(deps, runId, speaker(runId), input),
    sendThread: async (runId, input) => {
      const self = speaker(runId);
      if (!threads.get(db, input.threadId)) return "No such thread.";
      const sent = await deps.send(runId, input.threadId, input.text, input.requestKey);
      // Only once it is delivered, so the turn it hears about is the one the message joined or started.
      if (input.reportBack && sent.delivered) orclingFollowups.arm(db, input.threadId, self.id);
      return json({ ...sent, ...(input.reportBack && sent.delivered ? { reportBack: "You'll hear once when that turn ends." } : {}) });
    },
  };
}

/** Talking to the person's other Orclings, in their own chats or in a group with the person. */
function talkTools(deps: Dependencies, speaker: Speaker): Pick<OrclingTools, "orclings" | "message" | "startGroup"> {
  const { db } = deps;
  const talk = deps.orclings.talk;
  return {
    orclings: async (runId) => json(talk.directory(speaker(runId).id)),
    message: async (runId, input) => {
      const self = speaker(runId);
      const to = talk.byName(input.to, self.id);
      const home = threads.get(db, to.threadId);
      await deps.runs.authorizeAppAction(
        runId,
        "thread_message",
        { toolName: "orcling_message", reason: `${self.name} wants to text ${to.name}.`, input: { to: to.name, text: input.text } },
        home ? executionMode(home.mode, home.permissionMode) : undefined,
      );
      await talk.direct(self.id, runs.get(db, runId)?.threadId ?? null, to.name, input.text);
      return json({ delivered: true, to: to.name, note: `${to.name}'s answer reaches you as a message from it.` });
    },
    startGroup: async (runId, input) => {
      const self = speaker(runId);
      const others = input.with.map((name) => talk.byName(name, self.id));
      await deps.runs.authorizeAppAction(
        runId,
        "thread_message",
        { toolName: "orcling_group_start", reason: `${self.name} wants to open a group chat with ${others.map((other) => other.name).join(", ")}.`, input },
        executionMode("act", "autonomous"),
      );
      const group = await talk.startGroup(self.id, input.with, input.title, input.text);
      return json({ group: group.title, threadId: group.threadId, members: others.map((other) => other.name) });
    },
  };
}

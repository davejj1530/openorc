import { messages, orclingGroups, orclings, projects, retiredTeams, runs, tasks, threads, type Db } from "@openorc/db";
import type { McpHost, OrclingTools } from "@openorc/mcp";
import { executionMode, reactionEmoji, WORKSPACE_ID, type MemoryType, type Orcling, type Project, type TaskStatus } from "@openorc/protocol";
import { latestPersonMessage } from "../services/orcling-reactions.js";
import type { MemoryService } from "../services/memory.js";
import type { OrclingService } from "../services/orclings.js";
import type { RunService } from "../services/runs.js";
import type { AppSettingsService } from "../services/settings.js";
import type { ThreadService } from "../services/threads.js";

type Dependencies = {
  db: Db;
  orclings: Pick<OrclingService, "forRun" | "saveInstructions" | "startThread" | "startTask" | "react" | "talk">;
  memory: Pick<MemoryService, "assertEnabled" | "record" | "retrieveOrcling" | "retrieve" | "brief">;
  runs: Pick<RunService, "authorizeAppAction">;
  threads: Pick<ThreadService, "toolThreadRead">;
  settings: Pick<AppSettingsService, "get">;
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
      return `Reacted ${reactionEmoji[reaction]} to "${quoted}". If that says it all, end your turn without writing.`;
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

/**
 * New work runs as freely as the conversation that asked, within the Orcling's own permission, and opens with a
 * notice saying who started it rather than words the person did not type.
 */
function startSettings(db: Db, runId: string, opener: string, prompt: string) {
  const from = threads.get(db, runs.get(db, runId)?.threadId ?? "");
  return { mode: from?.mode ?? "act", permissionMode: from?.permissionMode ?? "review", prompt: `${opener}\n\n${prompt}`, promptRole: "system" as const };
}

/** Every place the person works: their Workspace, then their projects. */
function places(db: Db): Project[] {
  const workspace = projects.get(db, WORKSPACE_ID);
  return [...(workspace ? [workspace] : []), ...projects.list(db)];
}

/** The person's projects and Workspace: what is happening in them, and handing them work. */
function projectTools(deps: Dependencies, speaker: Speaker): Pick<OrclingTools, "projects" | "project" | "readThread" | "createTask" | "startWork" | "sendThread"> {
  const { db } = deps;
  const project = (id: string) => {
    const found = places(db).find((candidate) => candidate.id === id);
    if (!found) throw new Error("No such project. Call orcling_projects for the ids.");
    return found;
  };
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
      const chats = new Set([...orclings.list(db).map((orcling) => orcling.threadId), ...orclingGroups.list(db).map((group) => group.threadId)]);
      const recent = threads
        .list(db, { projectId, filter: "active", limit: 10 })
        .filter((t) => !retiredTeams.isHidden(db, t.id) && !chats.has(t.id))
        .map((t) => ({ id: t.id, title: t.title, agent: t.agent, active: age(t.lastActivityAt) }));
      const memory = query ? (await deps.memory.retrieve(projectId, query, 8)).map(({ memory: m }) => ({ title: m.title, body: m.body })) : deps.memory.brief(found);
      return json({ project: { id: found.id, name: found.name, folder: found.rootPath }, openTasks: open, threads: recent, memory });
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
    startWork: async (runId, input) => {
      const self = speaker(runId);
      const target = project(input.projectId);
      const { task, what } = workTarget(db, target, input);
      await deps.runs.authorizeAppAction(runId, "work_start", { toolName: "orcling_thread_start", reason: `${self.name} wants to start work in ${target.name}: ${what}`, input });
      const settings = startSettings(db, runId, `${self.name} started this ${task ? "task" : "thread"}.`, input.prompt);
      const threadId = task
        ? (await deps.orclings.startTask(self.id, task.id, settings)).threadId
        : (await deps.orclings.startThread(self.id, { ...settings, projectId: target.id, title: input.title ?? what, attachments: undefined, workspaceMode: deps.settings.get().defaultWorkspaceMode }))
            .thread.id;
      const thread = threads.get(db, threadId ?? "");
      deps.invalidate(["threads", "tasks"]);
      return json({
        ...(task ? { task: { id: task.id, title: task.title } } : {}),
        thread: { id: thread?.id ?? threadId, title: thread?.title ?? what },
        project: target.name,
        workingAs: self.name,
      });
    },
    sendThread: async (runId, input) => {
      speaker(runId);
      if (!threads.get(db, input.threadId)) return "No such thread.";
      return json(await deps.send(runId, input.threadId, input.text, input.requestKey));
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

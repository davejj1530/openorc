import { claudeAccounts, orclingGroups, orclings, projects, type Db } from "@openorc/db";
import type { OrclingTools } from "@openorc/mcp";
import { percentLeft, STATUS_PRIORITY, threadStatus, WORKSPACE_ID, type AgentKind, type Orcling, type PlanLimits, type ThreadSummary } from "@openorc/protocol";
import { newThreadAgent } from "../services/orcling-work.js";
import type { RunService } from "../services/runs.js";
import type { AppSettingsService } from "../services/settings.js";
import type { ThreadService } from "../services/threads.js";
import { agentModels } from "./orcling-models.js";

export type OverviewDependencies = {
  db: Db;
  runs: Pick<RunService, "models" | "attentionThreadIds" | "pending">;
  threads: Pick<ThreadService, "get" | "list">;
  settings: Pick<AppSettingsService, "get" | "enabledHarnesses">;
  planLimits: () => Promise<PlanLimits[]>;
};

const json = (value: unknown) => JSON.stringify(value);
const iso = (ts: number) => new Date(ts).toISOString();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** Orclings' own chats and group chats: private conversations, never the person's work. */
export function orclingChatIds(db: Db): Set<string> {
  return new Set([...orclings.list(db).map((orcling) => orcling.threadId), ...orclingGroups.list(db).map((group) => group.threadId)]);
}

/** A thread as the person's sidebar shows it: what it is doing, on what, and exactly when it last moved. */
export function threadLine(thread: ThreadSummary, options: { waitingFor?: string | undefined; titleOf?: (id: string) => string | undefined; accountOf?: (id: string) => string | undefined } = {}) {
  const parent = thread.parentThreadId;
  return {
    id: thread.id,
    title: thread.title,
    // A subthread was started under its parent and works in its folder; a subagent is the parent's agent's helper.
    ...(parent ? { under: { id: parent, title: options.titleOf?.(parent) ?? null }, as: thread.parentRelation === "subagent" ? "subagent" : "subthread" } : {}),
    status: threadStatus(thread)?.label ?? "Idle",
    ...(options.waitingFor ? { waitingFor: clip(options.waitingFor, 300) } : {}),
    agent: thread.agent,
    model: thread.model,
    ...(thread.agent === "claude" && thread.claudeAccountId ? { claudeAccount: options.accountOf?.(thread.claudeAccountId) ?? null } : {}),
    lastActive: iso(thread.lastActivityAt),
  };
}

/** Claude accounts by id, as their names; for a thread's line. */
export function accountNames(db: Db): (id: string) => string | undefined {
  const names = new Map(claudeAccounts.list(db).map((account) => [account.id, account.name]));
  return (id) => names.get(id);
}

/**
 * Threads as the sidebar nests them: each top thread with the subthreads under it, and how many more it has than shown.
 * A subthread whose parent is not among them stands alone and names it.
 */
export function threadTree(rows: readonly ThreadSummary[], titleOf: (id: string) => string | undefined, accountOf: (id: string) => string | undefined): unknown[] {
  const shown = new Set(rows.map((row) => row.id));
  const below = new Map<string, ThreadSummary[]>();
  for (const row of rows) if (row.parentThreadId && shown.has(row.parentThreadId)) below.set(row.parentThreadId, [...(below.get(row.parentThreadId) ?? []), row]);
  const nest = (row: ThreadSummary, nested: boolean): unknown => {
    const { under, ...line } = threadLine(row, { titleOf, accountOf });
    const children = below.get(row.id) ?? [];
    return {
      ...(nested ? line : { ...(under ? { under } : {}), ...line }),
      ...(children.length ? { subthreads: children.map((child) => nest(child, true)) } : {}),
      ...(row.hiddenChildren ? { moreSubthreads: row.hiddenChildren } : {}),
    };
  };
  return rows.filter((row) => !row.parentThreadId || !shown.has(row.parentThreadId)).map((row) => nest(row, false));
}

/** The person's OpenOrc as they would see it: what runs right now, what work can run on, and what is left of their plans. */
export function overviewTools(deps: OverviewDependencies, speaker: (runId: string) => Orcling): Pick<OrclingTools, "activity" | "models" | "usage"> {
  const { db } = deps;
  return {
    activity: async (runId) => {
      speaker(runId);
      const chats = orclingChatIds(db);
      const waiting = new Map<string, string>();
      for (const pending of deps.runs.pending()) if (pending.threadId && !waiting.has(pending.threadId)) waiting.set(pending.threadId, pending.detail);
      // Recent threads for results and failures; whatever is working or waiting, however old, by id.
      const found = new Map(deps.threads.list({ filter: "active", orderBy: "activity", limit: 60 }).map((thread) => [thread.id, thread]));
      for (const id of deps.runs.attentionThreadIds()) {
        const thread = found.has(id) ? null : deps.threads.get(id);
        if (thread) found.set(id, thread);
      }
      const names = new Map([...(projects.get(db, WORKSPACE_ID) ? [projects.get(db, WORKSPACE_ID)!] : []), ...projects.list(db)].map((project) => [project.id, project.name]));
      const rows = [...found.values()]
        .flatMap((thread) => {
          // An Orcling's chat is private, and so is the work running under it.
          const status = chats.has(thread.id) || chats.has(thread.parentThreadId ?? "") ? null : threadStatus(thread);
          return status ? [{ thread, status }] : [];
        })
        .sort((a, b) => STATUS_PRIORITY.indexOf(a.status.kind) - STATUS_PRIORITY.indexOf(b.status.kind) || b.thread.lastActivityAt - a.thread.lastActivityAt)
        .slice(0, 40);
      if (!rows.length) return json({ now: iso(Date.now()), threads: [], note: "Nothing is working, waiting on the person, failed or unread right now." });
      const titleOf = (id: string) => found.get(id)?.title ?? deps.threads.get(id)?.title;
      return json({
        now: iso(Date.now()),
        threads: rows.map(({ thread }) => ({
          ...threadLine(thread, { waitingFor: waiting.get(thread.id), titleOf, accountOf: accountNames(db) }),
          project: names.get(thread.projectId) ?? thread.projectId,
        })),
      });
    },
    models: async (runId, agent, search) => {
      const self = speaker(runId);
      const enabled = deps.settings.enabledHarnesses() as readonly AgentKind[];
      const agents = await Promise.all(
        (agent ? [agent] : enabled).map(async (each) => ({
          ...agentModels(db, each, await deps.runs.models(each).catch(() => []), search),
          ...(enabled.includes(each) ? {} : { turnedOff: true }),
        })),
      );
      const fallback = claudeAccounts.defaultId(db);
      const accounts = claudeAccounts
        .list(db)
        .filter((account) => account.enabled)
        .map((account) => ({ name: account.name, ...(account.id === fallback ? { default: true } : {}) }));
      const own = self.claudeAccountId ? accountNames(db)(self.claudeAccountId) : undefined;
      return json({
        newThreadsStartOn: newThreadAgent(db, deps.settings.get().defaultHarness, enabled) ?? { agent: null, why: "No agent is turned on." },
        agents,
        ...(accounts.length ? { claudeAccounts: accounts, note: "A project may use only some of them; orcling_project says which." } : {}),
        you: { agent: self.settings.agent, model: self.settings.model, ...(own ? { claudeAccount: own } : {}) },
      });
    },
    usage: async (runId) => {
      speaker(runId);
      const rows = await deps.planLimits();
      if (!rows.length) return "OpenOrc knows no plan usage for the person's agents.";
      return json(
        rows.map((row) => ({
          plan: row.plan ? `${row.name}, ${row.plan}` : row.name,
          agent: row.provider,
          status: row.status,
          windows: row.windows.map((window) => ({
            window: window.label,
            left: percentLeft(window) === null ? null : `${Math.round(percentLeft(window)!)}%`,
            resets: window.resetsAt ? iso(window.resetsAt) : null,
            ...(window.exhausted ? { exhausted: true } : {}),
          })),
          ...(row.credits?.length ? { credits: row.credits.map((credit) => `${credit.label}: ${credit.unlimited ? "unlimited" : (credit.balance ?? "unknown")}`) } : {}),
          checked: row.refreshedAt ? iso(row.refreshedAt) : null,
        })),
      );
    },
  };
}

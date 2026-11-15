import { WORKSPACE_ID, isDetachedCopy, type Project, type ThreadSummary } from "@openorc/protocol";

/** The tools a conversation's side panel holds. Each app draws its own icon for each by name. */
export type PanelTool = "newtab" | "orcling" | "plan" | "file" | "changes" | "tasks" | "task" | "terminal" | "browser" | "commits" | "checkpoints" | "memory" | "instructions";

export const panelToolLabels: Record<PanelTool, string> = {
  newtab: "New tab",
  browser: "Preview",
  changes: "Changes",
  terminal: "Terminal",
  file: "Files",
  plan: "Plan",
  tasks: "Tasks",
  task: "Task details",
  commits: "Commits",
  checkpoints: "Checkpoints",
  memory: "Memory",
  instructions: "Instructions",
  orcling: "Orcling",
};

/** What decides a panel's tools: whose panel it is, and for a thread whether it is a detached copy or an Orcling's. */
export type PanelToolContext =
  | { kind: "thread"; thread: Pick<ThreadSummary, "worktreePath" | "branch" | "orclingId">; project: Pick<Project, "id"> }
  | { kind: "task"; project: Pick<Project, "id"> }
  | { kind: "project"; project: Pick<Project, "id"> }
  | { kind: "newthread"; project: Pick<Project, "id">; changes: boolean };

/** Available tools are launchers, never tabs opened on the user's behalf. */
export function tabsFor(context: PanelToolContext): PanelTool[] {
  if (context.kind === "project") return ["changes", "file"];
  if (context.kind === "newthread") return [...(context.changes ? (["changes"] as const) : []), "terminal", "file", ...(context.changes ? (["commits"] as const) : []), "memory"];
  if (context.kind === "task") return context.project.id === WORKSPACE_ID ? ["terminal", "file", "task", "memory"] : ["changes", "terminal", "file", "task", "commits", "memory"];
  const tools: PanelTool[] =
    context.project.id === WORKSPACE_ID
      ? ["terminal", "file", "tasks", "plan", "memory", "instructions"]
      : ["changes", "terminal", "file", "plan", "tasks", "checkpoints", "commits", "memory", "instructions"];
  if (isDetachedCopy(context.thread)) tools.splice(tools.indexOf("commits"), tools.includes("commits") ? 1 : 0);
  if (context.thread.orclingId) tools.push("orcling");
  return tools;
}

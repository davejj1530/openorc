import { WORKSPACE_ID, isDetachedCopy, type Project, type Task, type ThreadSummary } from "@openorc/protocol";
import type { FileSelection, PanelTab } from "../lib/layout";
import { pageType, type PanelPage } from "../lib/panel-tabs";
import { fileIcon } from "./FileGlyph";
import { BookText, Brain, FileDiff, FileText, Folder, GitCommitHorizontal, Globe, History, ListTodo, Orcling, SlidersHorizontal, Terminal } from "./icons";

export type PanelContext =
  | { kind: "thread"; thread: ThreadSummary; project: Project; task?: Task }
  | { kind: "task"; task: Task; project: Project }
  | { kind: "project"; project: Project }
  | { kind: "newthread"; project: Project; workingDirectory: string; changes: boolean };

export const panelTools = {
  newtab: { label: "New tab", icon: Globe },
  browser: { label: "Preview", icon: Globe },
  changes: { label: "Changes", icon: FileDiff },
  terminal: { label: "Terminal", icon: Terminal },
  file: { label: "Files", icon: Folder },
  plan: { label: "Plan", icon: FileText },
  tasks: { label: "Tasks", icon: ListTodo },
  task: { label: "Task details", icon: SlidersHorizontal },
  commits: { label: "Commits", icon: GitCommitHorizontal },
  checkpoints: { label: "Checkpoints", icon: History },
  memory: { label: "Memory", icon: Brain },
  instructions: { label: "Instructions", icon: BookText },
  orcling: { label: "Orcling", icon: Orcling },
} satisfies Record<PanelTab, { label: string; icon: typeof Globe }>;

export function panelScope(context: PanelContext): string {
  if (context.kind === "thread") return `thread:${context.thread.id}`;
  if (context.kind === "task") return `task:${context.task.id}`;
  return `${context.kind}:${context.project.id}`;
}

/** The shell a Terminal page shows: the conversation's own, or the one its tab opened for itself. */
export function terminalId(context: PanelContext, page: Extract<PanelPage, { kind: "tool" }>): string {
  const base = context.kind === "newthread" ? `${panelScope(context)}:${panelDirectory(context)}` : panelScope(context);
  return page.shell ? `${base}:shell:${page.shell.id}` : base;
}

export function panelDirectory(context: PanelContext): string {
  if (context.kind === "newthread") return context.workingDirectory;
  if (context.kind === "thread") return context.thread.workingDirectory ?? context.thread.worktreePath ?? context.project.rootPath;
  if (context.kind === "task") return context.task.worktreePath ?? context.project.rootPath;
  return context.project.rootPath;
}

export function panelFileScope(context: PanelContext): FileSelection["scope"] {
  if (context.kind === "thread") return { kind: "thread", id: context.thread.id };
  if (context.kind === "task") return { kind: "task", id: context.task.id };
  if (context.kind === "newthread" && context.project.id === WORKSPACE_ID) return { kind: "project", id: context.project.id, workingDirectory: context.workingDirectory };
  return { kind: "project", id: context.project.id };
}

/** Available tools are launchers, never tabs opened on the user's behalf. */
export function tabsFor(context: PanelContext): PanelTab[] {
  if (context.kind === "project") return ["changes", "file"];
  if (context.kind === "newthread") return [...(context.changes ? (["changes"] as const) : []), "terminal", "file", ...(context.changes ? (["commits"] as const) : []), "memory"];
  if (context.kind === "task") return context.project.id === WORKSPACE_ID ? ["terminal", "file", "task", "memory"] : ["changes", "terminal", "file", "task", "commits", "memory"];
  const tools: PanelTab[] =
    context.project.id === WORKSPACE_ID
      ? ["terminal", "file", "tasks", "plan", "memory", "instructions"]
      : ["changes", "terminal", "file", "plan", "tasks", "checkpoints", "commits", "memory", "instructions"];
  if (isDetachedCopy(context.thread)) tools.splice(tools.indexOf("commits"), tools.includes("commits") ? 1 : 0);
  if (context.thread.orclingId) tools.push("orcling");
  return tools;
}

export function pageHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function pageLabel(page: PanelPage): string {
  if (page.kind === "browser") return page.title || (page.url ? pageHost(page.url) : "Preview");
  if (page.kind === "tool" && page.shell) return `${panelTools.terminal.label} ${page.shell.number}`;
  if (page.kind === "file" && page.selection) return page.selection.path.split(/[\\/]/).pop() ?? page.selection.path;
  return panelTools[page.kind === "tool" ? page.tool : page.kind].label;
}

/** A tab's mark: a file page shows what kind of file it holds, any other page its tool. */
export function pageIcon(page: PanelPage): typeof Globe {
  if (page.kind === "file" && page.selection) return fileIcon(page.selection.path);
  return panelTools[pageType(page)].icon;
}

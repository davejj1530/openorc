import { WORKSPACE_ID, type Project, type Task, type ThreadSummary } from "@openorc/protocol";
import { panelToolLabels, tabsFor as sharedTabsFor } from "@openorc/client";
import type { FileSelection, PanelTab } from "../lib/layout";
import { pageType, type PanelPage } from "../lib/panel-tabs";
import { fileIcon } from "./FileGlyph";
import { BookText, Brain, FileDiff, FileText, Folder, GitCommitHorizontal, Globe, History, ListTodo, Orcling, SlidersHorizontal, Smartphone, Terminal } from "./icons";

export type PanelContext =
  | { kind: "thread"; thread: ThreadSummary; project: Project; task?: Task }
  | { kind: "task"; task: Task; project: Project }
  | { kind: "project"; project: Project }
  | { kind: "newthread"; project: Project; workingDirectory: string; changes: boolean };

export const panelTools = {
  newtab: { label: panelToolLabels.newtab, icon: Globe },
  browser: { label: panelToolLabels.browser, icon: Globe },
  changes: { label: panelToolLabels.changes, icon: FileDiff },
  terminal: { label: panelToolLabels.terminal, icon: Terminal },
  file: { label: panelToolLabels.file, icon: Folder },
  plan: { label: panelToolLabels.plan, icon: FileText },
  tasks: { label: panelToolLabels.tasks, icon: ListTodo },
  task: { label: panelToolLabels.task, icon: SlidersHorizontal },
  commits: { label: panelToolLabels.commits, icon: GitCommitHorizontal },
  checkpoints: { label: panelToolLabels.checkpoints, icon: History },
  memory: { label: panelToolLabels.memory, icon: Brain },
  instructions: { label: panelToolLabels.instructions, icon: BookText },
  orcling: { label: panelToolLabels.orcling, icon: Orcling },
  device: { label: "Device", icon: Smartphone },
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

/** Available tools are launchers, never tabs opened on the user's behalf. The Device panel is the desktop's own. */
export function tabsFor(context: PanelContext): PanelTab[] {
  const tools: PanelTab[] = sharedTabsFor(context);
  return context.kind === "thread" || context.kind === "task" ? [...tools, "device"] : tools;
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
  if (page.kind === "device" && page.deviceId) return page.name;
  return panelTools[page.kind === "tool" ? page.tool : page.kind].label;
}

/** A tab's mark: a file page shows what kind of file it holds, any other page its tool. */
export function pageIcon(page: PanelPage): typeof Globe {
  if (page.kind === "file" && page.selection) return fileIcon(page.selection.path);
  return panelTools[pageType(page)].icon;
}

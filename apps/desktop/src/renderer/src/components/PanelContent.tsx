import { lazy } from "react";
import type { PanelPage } from "../lib/panel-tabs";
import { ChangesPanel } from "../panels/ChangesPanel";
import { CheckpointsPanel } from "../panels/CheckpointsPanel";
import { CommitsPanel, type CommitSource } from "../panels/CommitsPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { OrclingPanel } from "../panels/OrclingPanel";
import { TaskDetailsPanel } from "../panels/TaskDetailsPanel";
import { ThreadTasksPanel } from "../panels/ThreadTasksPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { panelDirectory, panelFileScope, panelScope, type PanelContext } from "./panel-tools";

const ConversationPlan = lazy(() => import("./ConversationPlan").then((m) => ({ default: m.ConversationPlan })));
const SavedChangesPanel = lazy(() => import("../panels/SavedChangesPanel").then((m) => ({ default: m.SavedChangesPanel })));
const ReviewPanel = lazy(() => import("../panels/ReviewPanel").then((m) => ({ default: m.ReviewPanel })));
const FilePanel = lazy(() => import("../panels/FilePanel").then((m) => ({ default: m.FilePanel })));
const TerminalPanel = lazy(() => import("../panels/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const InstructionsPanel = lazy(() => import("../panels/InstructionsPanel").then((m) => ({ default: m.InstructionsPanel })));

function commitSource(context: PanelContext): CommitSource | null {
  if (context.kind === "thread") return { kind: "thread", thread: context.thread, project: context.project };
  if (context.kind === "task") return { kind: "task", task: context.task };
  return context.kind === "newthread" && context.changes ? { kind: "checkout", project: context.project } : null;
}

function FileContent({ context, page }: ContentProps & { page: Extract<PanelPage, { kind: "file" }> }) {
  if (page.selection) return <FilePanel selection={page.selection} directory={panelDirectory(context)} />;
  return <FilesPanel scope={panelFileScope(context)} directory={panelDirectory(context)} />;
}

function ChangesContent({ context, page }: ContentProps & { page: Extract<PanelPage, { kind: "changes" }> }) {
  if (page.selection) return <SavedChangesPanel key={JSON.stringify(page.selection)} selection={page.selection} />;
  if (context.kind === "task") return <ReviewPanel task={context.task} project={context.project} />;
  return (
    <ChangesPanel key={panelScope(context)} thread={context.kind === "thread" ? context.thread : undefined} task={context.kind === "thread" ? context.task : undefined} project={context.project} />
  );
}

type ThreadTool = Exclude<Extract<PanelPage, { kind: "tool" }>["tool"], "terminal" | "commits" | "memory" | "task">;

function ThreadContent({ context, tool }: { context: Extract<PanelContext, { kind: "thread" }>; tool: ThreadTool }) {
  switch (tool) {
    case "plan":
      return <ConversationPlan key={context.thread.id} thread={context.thread} />;
    case "tasks":
      return <ThreadTasksPanel thread={context.thread} project={context.project} />;
    case "checkpoints":
      return <CheckpointsPanel key={context.thread.id} thread={context.thread} />;
    case "instructions":
      return <InstructionsPanel key={context.thread.id} threadId={context.thread.id} />;
    case "orcling":
      return context.thread.orclingId ? <OrclingPanel key={context.thread.orclingId} orclingId={context.thread.orclingId} /> : null;
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}

type ContentProps = { context: PanelContext; page: PanelPage; onNavigate: (page: PanelPage) => void };

export function PanelContent({ context, page, onNavigate }: ContentProps) {
  if (page.kind === "file") return <FileContent context={context} page={page} onNavigate={onNavigate} />;
  if (page.kind === "changes") return <ChangesContent context={context} page={page} onNavigate={onNavigate} />;
  if (page.kind !== "tool") return null;
  switch (page.tool) {
    case "terminal": {
      const cwd = panelDirectory(context);
      const id = context.kind === "newthread" ? `${panelScope(context)}:${cwd}` : panelScope(context);
      return <TerminalPanel key={id} id={id} cwd={cwd} />;
    }
    case "commits": {
      const source = commitSource(context);
      return source ? <CommitsPanel source={source} /> : null;
    }
    case "memory":
      return <MemoryPanel context={context} />;
    case "task":
      return context.kind === "task" ? <TaskDetailsPanel task={context.task} project={context.project} /> : null;
    default:
      return context.kind === "thread" ? <ThreadContent context={context} tool={page.tool} /> : null;
  }
}

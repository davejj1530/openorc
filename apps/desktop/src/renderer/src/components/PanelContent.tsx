import { lazy } from "react";
import { useLayout } from "../lib/layout";
import type { PanelPage } from "../lib/panel-tabs";
import { ChangesPanel } from "../panels/ChangesPanel";
import { HostedChangesPanel, HostedSavedChangesPanel } from "../panels/HostedChangesPanel";
import { HostedCommitsPanel } from "../panels/HostedCommitsPanel";
import { CheckpointsPanel } from "../panels/CheckpointsPanel";
import { CommitsPanel, type CommitSource } from "../panels/CommitsPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { OrclingPanel } from "../panels/OrclingPanel";
import { TaskDetailsPanel } from "../panels/TaskDetailsPanel";
import { ThreadTasksPanel } from "../panels/ThreadTasksPanel";
import { FileExplorer } from "../panels/FileExplorer";
import { panelDirectory, panelFileScope, panelScope, terminalId, type PanelContext } from "./panel-tools";
import { hostedUnavailablePanel } from "./HostedUnavailablePanel";
import { useHostedCapabilities } from "../hooks/useHostedCapabilities";

const ConversationPlan = lazy(() => import("./ConversationPlan").then((m) => ({ default: m.ConversationPlan })));
const SavedChangesPanel = lazy(() => import("../panels/SavedChangesPanel").then((m) => ({ default: m.SavedChangesPanel })));
const ReviewPanel = lazy(() => import("../panels/ReviewPanel").then((m) => ({ default: m.ReviewPanel })));
const FilePanel = lazy(() => import("../panels/FilePanel").then((m) => ({ default: m.FilePanel })));
const TerminalPanel = lazy(() => import("../panels/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const CloudTerminalPanel = lazy(() => import("../panels/CloudTerminalPanel").then((m) => ({ default: m.CloudTerminalPanel })));
const InstructionsPanel = lazy(() => import("../panels/InstructionsPanel").then((m) => ({ default: m.InstructionsPanel })));

function commitSource(context: PanelContext): CommitSource | null {
  if (context.kind === "thread") return { kind: "thread", thread: context.thread, project: context.project };
  if (context.kind === "task") return { kind: "task", task: context.task };
  return context.kind === "newthread" && context.changes ? { kind: "checkout", project: context.project } : null;
}

function FileContent({ context, page }: ContentProps & { page: Extract<PanelPage, { kind: "file" }> }) {
  if (page.selection) return <FilePanel selection={page.selection} directory={panelDirectory(context)} />;
  return <FileExplorer scope={panelFileScope(context)} directory={panelDirectory(context)} name={context.project.name} />;
}

function ChangesContent({ context, page, onNavigate }: ContentProps & { page: Extract<PanelPage, { kind: "changes" }> }) {
  // From one turn's saved changes to all of them, in the same tab: the layout's selection goes too, so no later
  // request for the changes tab brings the turn back.
  const all = () => {
    useLayout.getState().clearChanges();
    onNavigate({ kind: "changes", selection: null });
  };
  if (page.selection && context.kind === "thread" && context.thread.owner?.brain === "hosted")
    return <HostedSavedChangesPanel key={JSON.stringify(page.selection)} selection={page.selection} onAll={all} />;
  if (page.selection) return <SavedChangesPanel key={JSON.stringify(page.selection)} selection={page.selection} onAll={all} />;
  if (context.kind === "task") return <ReviewPanel task={context.task} project={context.project} />;
  if (context.kind === "thread" && context.thread.owner?.brain === "hosted") return <HostedChangesPanel key={context.thread.id} thread={context.thread} />;
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

/** A cloud thread's terminal is a shell on its machine; any other is a shell on this Mac. */
function TerminalContent({ context, page }: { context: PanelContext; page: Extract<PanelPage, { kind: "tool" }> }) {
  if (context.kind === "thread" && context.thread.owner?.brain === "hosted") {
    const slot = page.shell?.id ?? "main";
    return <CloudTerminalPanel key={`${context.thread.id}:${slot}`} threadId={context.thread.id} slot={slot} />;
  }
  const id = terminalId(context, page);
  return <TerminalPanel key={id} id={id} cwd={panelDirectory(context)} />;
}

/** The commits of the panel's source, or the one commit the page names. A commit and its list are pages of the same tab, so Back returns to the list. */
function CommitsContent({ context, page, onNavigate }: ContentProps & { page: Extract<PanelPage, { kind: "tool" }> }) {
  const commit = page.commit ?? null;
  const open = (next: string | null) => onNavigate({ kind: "tool", tool: "commits", ...(next ? { commit: next } : {}) });
  if (context.kind === "thread" && context.thread.owner?.brain === "hosted") return <HostedCommitsPanel key={context.thread.id} thread={context.thread} commit={commit} onOpen={open} />;
  const source = commitSource(context);
  return source ? <CommitsPanel source={source} commit={commit} onOpen={open} /> : null;
}

export function PanelContent({ context, page, onNavigate }: ContentProps) {
  const availability = useHostedCapabilities(context.kind === "thread" ? context.thread : null);
  const unavailable = hostedUnavailablePanel(context, page, availability.reason);
  if (unavailable) return unavailable;
  if (page.kind === "file") return <FileContent context={context} page={page} onNavigate={onNavigate} />;
  if (page.kind === "changes") return <ChangesContent context={context} page={page} onNavigate={onNavigate} />;
  if (page.kind !== "tool") return null;
  switch (page.tool) {
    case "terminal":
      return <TerminalContent context={context} page={page} />;
    case "commits":
      return <CommitsContent context={context} page={page} onNavigate={onNavigate} />;
    case "memory":
      return <MemoryPanel context={context} />;
    case "task":
      return context.kind === "task" ? <TaskDetailsPanel task={context.task} project={context.project} /> : null;
    default:
      return context.kind === "thread" ? <ThreadContent context={context} tool={page.tool} /> : null;
  }
}

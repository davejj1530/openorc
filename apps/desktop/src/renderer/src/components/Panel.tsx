import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  PanelRight,
  PanelRightClose,
  BookText,
  FileText,
  FileDiff,
  ListTodo,
  SlidersHorizontal,
  GitCommitHorizontal,
  Globe,
  History,
  Brain,
  Maximize2,
  Minimize2,
  Orcling,
  Plus,
  Terminal,
} from "./icons";
import { WORKSPACE_ID, isDetachedCopy } from "@openorc/protocol";
import type { Project, PushState, Task, ThreadSummary } from "@openorc/protocol";
import { ResizeHandle } from "./ResizeHandle";
import { menuItem, menuPopup } from "./ThreadActions";
import { Button, Empty, IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useConversationPlans } from "../lib/conversation-plans";
import { useLayout, type PanelTab } from "../lib/layout";
import { closedTools, isPanelTool, visibleTabs, type PanelSignals, type PanelTool } from "../lib/panel-tabs";
import { useProjectGit } from "../lib/project-git";
import { useRpc } from "../lib/query";
import { useTrafficLights, useWindowsControls } from "../lib/window";
import { CoversPreview, useBrowserPreview } from "../lib/browser-preview";
import { ChangesPanel } from "../panels/ChangesPanel";
import { CheckpointsPanel } from "../panels/CheckpointsPanel";
import { CommitsPanel, type CommitSource } from "../panels/CommitsPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { OrclingPanel } from "../panels/OrclingPanel";
import { TaskDetailsPanel } from "../panels/TaskDetailsPanel";
import { ThreadTasksPanel } from "../panels/ThreadTasksPanel";

const ConversationPlan = lazy(() => import("./ConversationPlan").then((m) => ({ default: m.ConversationPlan })));
const SavedChangesPanel = lazy(() => import("../panels/SavedChangesPanel").then((m) => ({ default: m.SavedChangesPanel })));
const ReviewPanel = lazy(() => import("../panels/ReviewPanel").then((m) => ({ default: m.ReviewPanel })));
const FilePanel = lazy(() => import("../panels/FilePanel").then((m) => ({ default: m.FilePanel })));
// xterm and its stylesheet are a chunk only a reader who opens a terminal pays for.
const TerminalPanel = lazy(() => import("../panels/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const BrowserPanel = lazy(() => import("../panels/BrowserPanel").then((m) => ({ default: m.BrowserPanel })));
const InstructionsPanel = lazy(() => import("../panels/InstructionsPanel").then((m) => ({ default: m.InstructionsPanel })));

/** What the third column can show for the thing selected in the main column. */
export type PanelContext =
  /** A task screen shows the conversation the task works in, labeled with the task. */
  | { kind: "thread"; thread: ThreadSummary; project: Project; task?: Task }
  | { kind: "task"; task: Task; project: Project }
  | { kind: "project"; project: Project }
  | { kind: "newthread"; project: Project; workingDirectory: string; changes: boolean };

function panelEntityId(context: PanelContext): string | null {
  if (context.kind === "thread") return context.thread.id;
  if (context.kind === "task") return context.task.id;
  return null;
}

function panelOwner(context: PanelContext): ThreadSummary | Task | null {
  if (context.kind === "thread") return context.thread;
  if (context.kind === "task") return context.task;
  return null;
}

const icons = {
  orcling: Orcling,
  plan: FileText,
  file: FileText,
  changes: FileDiff,
  tasks: ListTodo,
  task: SlidersHorizontal,
  terminal: Terminal,
  browser: Globe,
  commits: GitCommitHorizontal,
  checkpoints: History,
  memory: Brain,
  instructions: BookText,
};
const labels: Record<PanelTab, string> = {
  orcling: "Orcling",
  plan: "Plan",
  file: "Files",
  changes: "Changes",
  tasks: "Tasks",
  task: "Task",
  terminal: "Terminal",
  browser: "Preview",
  commits: "Commits",
  checkpoints: "Checkpoints",
  memory: "Memory",
  instructions: "Instructions",
};

/**
 * Every tab a context can offer, in strip order. Which of them show is decided by
 * visibleTabs: Terminal and Preview sit next to Changes because all three answer
 * "what is happening in this workspace", and both need the same cwd the diff is
 * read from. Instructions follows Memory, since both are what the agent knows.
 */
export function tabsFor(context: PanelContext): PanelTab[] {
  if (context.kind === "project") return ["changes"];
  if (context.kind === "newthread") return [...(context.changes ? (["changes", "commits"] as const) : []), "terminal", "browser", "memory"];
  if (context.kind === "task") return context.project.id === WORKSPACE_ID ? ["task", "terminal", "browser", "memory"] : ["changes", "terminal", "browser", "task", "commits", "memory"];
  // The Orcling working in a conversation comes first: its profile is who you are talking to.
  const orcling: PanelTab[] = context.thread.orclingId ? ["orcling"] : [];
  if (context.project.id === WORKSPACE_ID) return [...orcling, "tasks", "plan", "terminal", "browser", "memory", "instructions"];
  return [...orcling, "changes", "plan", "terminal", "browser", "tasks", "checkpoints", "commits", "memory", "instructions"];
}

/** Tabs that belong to a conversation alone. */
function threadTabBody(current: PanelTab, context: Extract<PanelContext, { kind: "thread" }>): ReactNode {
  switch (current) {
    case "tasks":
      return <ThreadTasksPanel thread={context.thread} project={context.project} />;
    case "checkpoints":
      return <CheckpointsPanel key={context.thread.id} thread={context.thread} />;
    case "instructions":
      return <InstructionsPanel key={context.thread.id} threadId={context.thread.id} />;
    case "orcling":
      return context.thread.orclingId ? <OrclingPanel key={context.thread.orclingId} orclingId={context.thread.orclingId} /> : null;
    default:
      return null;
  }
}

function useSelectedFile(context: PanelContext) {
  const file = useLayout((s) => s.selectedFile);
  const id = panelEntityId(context);
  return file && file.scope.kind === context.kind && file.scope.id === id ? file : null;
}

/** A saved diff shows only beside the conversation it came from. */
function useSelectedChanges(context: PanelContext) {
  const changes = useLayout((s) => s.selectedChanges);
  if (!changes) return null;
  const here =
    changes.kind === "thread"
      ? context.kind === "thread" && changes.id === context.thread.id
      : (!changes.taskId && context.kind === "thread" && changes.threadId === context.thread.id) || (context.kind === "task" && changes.taskId === context.task.id);
  return here ? changes : null;
}

/** The key a panel's opened tools are remembered under, matching the keys its panes use. */
function panelScope(context: PanelContext): string | null {
  if (context.kind === "thread") return `thread:${context.thread.id}`;
  if (context.kind === "task") return `task:${context.task.id}`;
  if (context.kind === "newthread") return `newthread:${context.project.id}`;
  return null;
}

/** Where a context's commits come from: a new thread's is the checkout it would work in. Null when it has none. */
function commitSource(context: PanelContext): CommitSource | null {
  if (context.kind === "thread") return { kind: "thread", thread: context.thread, project: context.project };
  if (context.kind === "task") return { kind: "task", task: context.task };
  return context.kind === "newthread" && context.changes ? { kind: "checkout", project: context.project } : null;
}

/** Whether the branch has commits origin lacks. Push is offered for them wherever they came from. */
const hasCommitsToPush = (state: PushState | undefined) => Boolean(state?.unpushedCount);

/**
 * Whether a thread's Commits tab has something to show: commits of its own, or ones origin lacks on its branch, whoever
 * made them. A pull request's copy under review publishes nothing; a team publishes through a branch of its own.
 */
function useThreadCommits(thread: ThreadSummary | null, git: boolean): boolean {
  const id = thread?.id ?? "";
  const publishes = thread !== null && (Boolean(thread.teamInstanceId) || !isDetachedCopy(thread));
  const log = useRpc("git.threadLog", { threadId: id }, { enabled: git });
  const push = useRpc("git.threadPushState", { threadId: id }, { enabled: git && publishes });
  if (!thread || !publishes) return false;
  // A worktree's log starts at its base. A shared checkout's log is the repository's, so only
  // the commits made since the thread began are its own.
  const own = thread.worktreePath && thread.baseSha ? (log.data ?? []) : (log.data ?? []).filter((commit) => commit.at >= thread.createdAt);
  return own.length > 0 || hasCommitsToPush(push.data);
}

/**
 * What a thread has to show, read mostly from queries the open thread already runs: the
 * composer's diff and the transcript's plans and checkpoints. Tasks and projects keep their
 * full strip.
 */
function usePanelSignals(context: PanelContext, savedChanges: boolean): PanelSignals {
  const thread = context.kind === "thread" ? context.thread : null;
  const id = thread?.id ?? "";
  const { tracks } = useProjectGit(context.project.id);
  const git = thread !== null && tracks;
  const diff = useRpc("review.threadDiff", { threadId: id, comparison: "head" }, { enabled: git });
  const { plans } = useConversationPlans(id, Boolean(thread?.teamInstanceId), thread !== null);
  const tasks = useRpc("tasks.list", { threadId: id }, { enabled: thread !== null });
  const checkpoints = useRpc("threads.checkpoints", { id }, { enabled: thread !== null });
  const commits = useThreadCommits(thread, git);
  const checkoutPush = useRpc("git.projectPushState", { projectId: context.project.id }, { enabled: context.kind === "newthread" && context.changes });
  const memory = useRpc("memory.list", { projectId: context.project.id, limit: 40 }, { enabled: context.kind === "thread" || context.kind === "newthread" });
  if (context.kind === "newthread") return { changes: true, commits: hasCommitsToPush(checkoutPush.data), memory: Boolean(memory.data?.length) };
  if (!thread) return null;
  return {
    changes: savedChanges || Boolean(diff.data?.files.length),
    plan: plans.length > 0,
    tasks: Boolean(tasks.data?.length),
    checkpoints: Boolean(checkpoints.data?.length),
    commits,
    memory: Boolean(memory.data?.length),
  };
}

/** The tab this panel was switched to since it mounted. It stays in the strip even when empty. */
function usePinnedTab(tab: PanelTab): PanelTab | null {
  const initial = useRef(tab);
  return tab === initial.current ? null : tab;
}

function PanelTabs({ tabs, current }: { tabs: PanelTab[]; current: PanelTab | undefined }) {
  const open = useLayout((s) => s.panelOpen);
  const setPanel = useLayout((s) => s.setPanel);
  return (
    <div role="tablist" className="panel-tabs flex items-center gap-0.5">
      {tabs.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={open && current === t}
          aria-label={labels[t]}
          title={labels[t]}
          onClick={() => setPanel(!(open && current === t), t)}
          className={cn("panel-tab inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-sm text-ink-3 hover:text-ink hover:bg-surface-2", open && current === t && "text-ink font-medium")}
        >
          {(() => {
            const Icon = icons[t];
            return <Icon size={14} />;
          })()}
          <span className="panel-tab-label" data-selected={open && current === t}>
            {labels[t]}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Tools join the strip from here, once per scope. */
function ToolMenu({ tools, onOpen }: { tools: PanelTool[]; onOpen: (tool: PanelTool) => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label="Open a tool" />}>
        <Plus size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
          <Menu.Popup className={menuPopup}>
            {tools.map((tool) => {
              const Icon = icons[tool];
              return (
                <Menu.Item key={tool} className={menuItem} onClick={() => onOpen(tool)}>
                  <Icon size={14} />
                  {labels[tool]}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const noTools: PanelTool[] = [];

/** How long .panel-shell takes to slide shut in app.css. The body outlives the close by exactly that. */
const PANE_MS = 220;

/**
 * True while the panel is open, and for as long as it takes to slide shut.
 * The body holds polling queries and diff workers, so it may not stay mounted
 * behind a closed panel; it may not vanish mid-slide either, which would
 * animate an empty column out.
 */
function useMountedThroughClose(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), PANE_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return open || mounted;
}

/** The third column. Opens beside the conversation for review, tasks, details, or memory. */
export function Panel({ context }: { context: PanelContext }) {
  const open = useLayout((s) => s.panelOpen);
  const tab = useLayout((s) => s.panelTab);
  const setPanel = useLayout((s) => s.setPanel);
  const windowsControls = useWindowsControls();
  const file = useSelectedFile(context);
  const mounted = useMountedThroughClose(open);
  const scopedChanges = useSelectedChanges(context);
  const previewUrls = useLayout((s) => s.previewUrls);
  const rememberPreviewUrl = useLayout((s) => s.rememberPreviewUrl);
  const browserSurface = context.kind === "thread" || context.kind === "task" ? panelScope(context) : null;
  const revealBrowser = useCallback(() => setPanel(true, "browser"), [setPanel]);
  useBrowserPreview(browserSurface, revealBrowser);
  const scope = panelScope(context);
  const opened = useLayout((s) => (scope ? s.panelTools[scope] : undefined)) ?? noTools;
  const rememberPanelTool = useLayout((s) => s.rememberPanelTool);
  const signals = usePanelSignals(context, scopedChanges !== null);
  const pinned = usePinnedTab(tab);
  const candidates = tabsFor(context);
  if (file) candidates.unshift("file");
  const tabs = visibleTabs(candidates, signals, opened, pinned);
  const tools = closedTools(candidates, tabs);
  const current = tabs.includes(tab) ? tab : tabs[0];
  const openTool = (tool: PanelTool) => {
    if (scope) rememberPanelTool(scope, tool);
    setPanel(true, tool);
  };
  // Remembered wherever it was opened from: the add menu, the agent's browser, a restored layout.
  useEffect(() => {
    if (open && scope && current && isPanelTool(current)) rememberPanelTool(scope, current);
  }, [open, scope, current, rememberPanelTool]);
  const expandedPreview = useLayout((s) => s.panelExpanded);
  const setPanelExpanded = useLayout((s) => s.setPanelExpanded);
  // The two tabs that gain from width: a page at its real size, and a diff side by side.
  const expandable = current === "browser" || current === "changes";
  const expanded = open && expandedPreview && expandable;
  useEffect(() => {
    if (expandedPreview && !expandable) setPanelExpanded(false);
  }, [expandedPreview, expandable, setPanelExpanded]);
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const trafficLights = useTrafficLights();
  const source = commitSource(context);

  let body: ReactNode = null;
  if (!current)
    body = (
      <Empty
        title="Nothing here yet"
        icon={<PanelRight size={20} />}
        action={
          tools.length ? (
            <div className="flex gap-2">
              {tools.map((tool) => (
                <Button key={tool} size="sm" onClick={() => openTool(tool)}>
                  {labels[tool]}
                </Button>
              ))}
            </div>
          ) : null
        }
      >
        Changes, plans and tasks show up here as the work produces them.
      </Empty>
    );
  else if (current === "plan" && context.kind === "thread") body = <ConversationPlan key={context.thread.id} thread={context.thread} />;
  else if (current === "file" && file) body = <FilePanel selection={file} />;
  else if (current === "changes" && scopedChanges) body = <SavedChangesPanel key={JSON.stringify(scopedChanges)} selection={scopedChanges} />;
  else if (current === "changes")
    body =
      context.kind === "task" ? (
        <ReviewPanel task={context.task} project={context.project} />
      ) : (
        <ChangesPanel
          key={context.kind === "thread" ? context.thread.id : context.project.id}
          thread={context.kind === "thread" ? context.thread : undefined}
          task={context.kind === "thread" ? context.task : undefined}
          project={context.project}
        />
      );
  else if (current === "terminal" && context.kind !== "project") {
    // The shell opens where the diff is read from, so the two tabs describe the
    // same tree. Keyed by surface, which is also the key the shell outlives on.
    const owner = panelOwner(context);
    const cwd = context.kind === "newthread" ? context.workingDirectory : ((context.kind === "thread" ? context.thread.workingDirectory : null) ?? owner?.worktreePath ?? context.project.rootPath);
    const id = context.kind === "newthread" ? `newthread:${context.project.id}:${cwd}` : `${context.kind}:${context.kind === "thread" ? context.thread.id : context.task.id}`;
    body = <TerminalPanel key={id} id={id} cwd={cwd} />;
  } else if (current === "browser" && context.kind !== "project") {
    const owner = scope ?? `newthread:${context.project.id}`;
    body = <BrowserPanel key={owner} id={owner} defaultUrl={previewUrls[owner] ?? "http://localhost:3000"} onUrl={(url) => rememberPreviewUrl(owner, url)} />;
  } else if (current === "task" && context.kind === "task") body = <TaskDetailsPanel task={context.task} project={context.project} />;
  else if (current === "commits" && source) body = <CommitsPanel source={source} />;
  else if (current === "memory" && context.kind !== "project") body = <MemoryPanel context={context} />;
  else if (context.kind === "thread") body = threadTabBody(current, context);

  return (
    <>
      {/* The seam is only grabbable against an open panel; a closed one has no edge to drag. */}
      {open && !expanded ? <ResizeHandle edge="panel" /> : null}
      <aside
        className="panel-shell shrink-0 h-full"
        data-open={open}
        data-expanded={expanded || undefined}
        data-thread-owner={context.kind === "thread" ? context.thread.id : undefined}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(event) => {
          if (expanded && event.key === "Escape") setPanelExpanded(false);
        }}
      >
        <div className="panel-pane h-full flex flex-col">
          <header
            className={cn(
              "drag-region h-topbar shrink-0 flex items-center gap-2 border-b border-line",
              expanded && !sidebarOpen && trafficLights ? "pl-traffic" : "pl-3",
              windowsControls ? "pr-controls" : "pr-2",
            )}
          >
            <PanelTabs tabs={tabs} current={current} />
            {tools.length ? <ToolMenu tools={tools} onOpen={openTool} /> : null}
            <span className="flex-1" />
            {expandable ? (
              <Tooltip label={expanded ? "Collapse panel" : "Expand panel"}>
                <IconButton onClick={() => setPanelExpanded(!expanded)} aria-label={expanded ? "Collapse panel" : "Expand panel"} aria-pressed={expanded} className="no-drag">
                  {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip label="Hide panel">
              <IconButton onClick={() => setPanel(false)} aria-label="Hide panel" className="no-drag">
                <PanelRightClose size={15} />
              </IconButton>
            </Tooltip>
          </header>
          <div className="panel-content flex-1 min-h-0">{mounted ? <Suspense fallback={null}>{body}</Suspense> : null}</div>
        </div>
      </aside>
    </>
  );
}

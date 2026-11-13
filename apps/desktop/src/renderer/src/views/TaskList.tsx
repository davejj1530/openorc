import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import type { Project, Task, TaskStatus } from "@openorc/protocol";
import { Check, Cloud, Funnel, Plus } from "../components/icons";
import { ListGroupHeading } from "../components/ListGroupHeading";
import { ProjectLogo } from "../components/ProjectIconPicker";
import { StatusIcon, groupLabel, groupOrder, statusLabel, statusOrder } from "../components/status";
import { ScopedTitle } from "../components/ScopedTitle";
import { TopBar } from "../components/TopBar";
import { TaskStart } from "../components/TaskStart";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { Button, Empty, IconButton, metaSlot, StatusDot } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { focusedProject, useLayout } from "../lib/layout";
import { useRpc, useRpcMutation } from "../lib/client";
import { openTask } from "../lib/router";
import { ownerMark, relativeTime } from "@openorc/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { stageCount } from "../lib/task-stage-counts";
import "./pages.css";

function TaskRowStatus({ task, onMoved }: { task: Task; onMoved: () => void }) {
  const update = useRpcMutation("tasks.update");
  const feedbackId = useId();
  return (
    <div className="task-row-status relative shrink-0">
      <Menu.Root>
        <Menu.Trigger
          render={<IconButton aria-label={`Status for ${task.title}`} size="xs" />}
          aria-describedby={update.error || update.isPending ? feedbackId : undefined}
          aria-busy={update.isPending}
          data-tip={`Change status · ${statusLabel[task.status]}`}
          disabled={update.isPending}
        >
          <StatusIcon status={task.status} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              {statusOrder.map((status) => (
                <Menu.Item
                  key={status}
                  className={menuItem}
                  onClick={() => {
                    if (status !== task.status) update.mutate({ id: task.id, patch: { status } }, { onSuccess: onMoved });
                  }}
                >
                  <StatusIcon status={status} />
                  <span className="flex-1">{statusLabel[status]}</span>
                  {status === task.status ? <Check size={13} className="text-ink-3" /> : null}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {update.isPending ? (
        <p id={feedbackId} role="status" className="sr-only">
          Saving…
        </p>
      ) : null}
      {update.error ? (
        <p id={feedbackId} role="alert" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md bg-float-fill px-2.5 py-1.5 text-sm text-bad break-words">
          Couldn’t change status: {update.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** The list's groups: what waits on the person first (an approval, a review, a proposal), then the rest. */
type TaskGroupKey = TaskStatus | "approval";

const WAITING: readonly TaskGroupKey[] = ["approval", "review", "proposed"];
const GROUPS: readonly TaskStatus[] = ["review", "proposed", ...groupOrder.filter((status) => status !== "review" && status !== "proposed")];

/** A task opens on its conversation while its run asks for an approval, where the approval waits; otherwise on its page. */
const openRow = (task: Task) => openTask(task.id, task.approval ? "chat" : "spec");

function taskGroups(tasks: readonly Task[]): { key: TaskGroupKey; label: string; tasks: Task[] }[] {
  return [
    { key: "approval" as const, label: "Needs you", tasks: tasks.filter((task) => task.approval) },
    ...GROUPS.map((status) => ({ key: status, label: groupLabel[status], tasks: tasks.filter((task) => task.status === status && !task.approval) })),
  ].filter((group) => group.tasks.length > 0);
}

/**
 * Grouped rows with keyboard navigation: j/k or arrows move, Enter opens.
 * The list owns focus so the shortcuts work without clicking first.
 */
function TaskRows({ tasks, showProject }: { tasks: Task[]; showProject: boolean }) {
  const projects = useRpc("projects.list", {}, { enabled: showProject });
  const projectOf = (id: string) => projects.data?.find((p) => p.id === id);
  const groupId = useId();
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskGroupKey, boolean>>>({});
  const groups = useMemo(() => taskGroups(tasks), [tasks]);
  const flat = useMemo(() => groups.flatMap((g) => (collapsed[g.key] ? [] : g.tasks)), [groups, collapsed]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cursor >= flat.length) setCursor(Math.max(0, flat.length - 1));
  }, [flat.length, cursor]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest("[data-task-open]")) return;
    if (flat.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
      listRef.current?.focus();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
      listRef.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = flat[cursor];
      if (t) openRow(t);
    }
  };

  let index = -1;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="task-list flex-1 min-h-0 overflow-y-auto outline-none" autoFocus>
        {groups.map(({ key, label, tasks: group }) => (
          <section key={key} className="list-group" data-status-group={key} aria-labelledby={`${groupId}-${key}-header`}>
            <ListGroupHeading
              id={`${groupId}-${key}-header`}
              controls={`${groupId}-${key}-tasks`}
              collapsed={Boolean(collapsed[key])}
              onToggle={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))}
              label={label}
              count={WAITING.includes(key) ? { value: group.length, label: `${group.length} waiting on you`, waiting: true } : null}
            />
            <div id={`${groupId}-${key}-tasks`} hidden={Boolean(collapsed[key])}>
              {group.map((t) => {
                if (!collapsed[key]) index += 1;
                const i = index;
                return (
                  <div key={t.id} data-row={collapsed[key] ? undefined : i}>
                    <div data-current={i === cursor || undefined} data-status={t.status} className="task-list-row">
                      <TaskRowStatus task={t} onMoved={() => listRef.current?.focus({ preventScroll: true })} />
                      <button
                        data-task-open
                        onClick={() => openRow(t)}
                        tabIndex={i === cursor ? 0 : -1}
                        onFocus={() => setCursor(i)}
                        aria-label={`${t.title}, ${t.approval ? "needs your approval" : statusLabel[t.status]}`}
                      >
                        <span className="task-row-title" data-tip={t.title}>
                          {t.title}
                        </span>
                        {t.labels[0] ? (
                          <span className="task-row-meta task-row-label">
                            <StatusDot tone="muted" />
                            <span className="truncate">{t.labels[0]}</span>
                          </span>
                        ) : null}
                        <TaskOwnerMark task={t} />
                        {showProject ? <TaskProject project={projectOf(t.projectId)} /> : null}
                        <span className={cn(metaSlot, "task-row-meta task-row-time")}>{relativeTime(t.updatedAt)}</span>
                      </button>
                      <TaskMove task={t} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** A task's project in its fixed column: the project's mark, then its name. */
function TaskProject({ project }: { project: Project | undefined }) {
  return (
    <span className="task-row-meta task-row-project">
      {project ? (
        <>
          <ProjectLogo project={project} />
          <span className="truncate">{project.name}</span>
        </>
      ) : null}
    </span>
  );
}

/** The row's last column: Review on a task ready for review, the way to its thread before work starts, else nothing. */
function TaskMove({ task }: { task: Task }) {
  return (
    <span className="task-row-move">
      {task.status === "review" ? (
        <Button size="sm" onClick={() => openTask(task.id, "files")}>
          Review
        </Button>
      ) : null}
      {task.status === "backlog" || task.status === "proposed" ? <TaskStart task={task} /> : null}
    </span>
  );
}

/** Where a task the Mac lists from its cloud brain lives, as thread rows say it. */
function TaskOwnerMark({ task }: { task: Task }) {
  const mark = ownerMark({ owner: task.owner, moving: undefined });
  if (!mark) return null;
  return (
    <span className={cn("task-row-meta inline-flex shrink-0 items-center gap-1", mark.dim && "opacity-60")}>
      <Cloud size={12} />
      {mark.label}
    </span>
  );
}

const shelfOptions = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
] as const;

type TaskShelf = "active" | "done" | "archived";

function taskListBody(input: { error: Error | null; loading: boolean; list: Task[]; shelf: TaskShelf; stage: TaskStatus | null; showProject: boolean; retry: () => void }): ReactNode {
  if (input.error)
    return (
      <Empty title="Tasks couldn’t load">
        <Button onClick={input.retry}>Try again</Button>
      </Empty>
    );
  if (input.loading) return <div className="document-skeleton" aria-label="Loading tasks" />;
  if (input.list.length > 0) return <TaskRows tasks={input.list} showProject={input.showProject} />;
  if (input.stage) return <Empty title={`No ${statusLabel[input.stage].toLowerCase()} tasks`} />;
  return <Empty title={input.shelf === "active" ? "No tasks yet" : `No ${input.shelf} tasks`} />;
}

export function TaskListView({ onNewTask }: { onNewTask: () => void }) {
  const projectId = useLayout(focusedProject);
  const tasks = useRpc("tasks.list", projectId ? { projectId } : {});
  const [shelf, setShelf] = useState<TaskShelf>("active");
  const all = tasks.data ?? [];
  const [stage, setStage] = useState<TaskStatus | null>(null);
  const list = all.filter((task) => (shelf === "active" ? task.status !== "done" && task.status !== "archived" : task.status === shelf) && (!stage || task.status === stage));
  return (
    <>
      <TopBar
        actions={
          <>
            <TaskFilterMenu
              tasks={all}
              shelf={shelf}
              stage={stage}
              onShelf={(value) => {
                setShelf(value);
                setStage(null);
              }}
              onStage={setStage}
            />
            <Button variant="primary" size="lg" className="ml-1 pl-2.5" onClick={onNewTask}>
              <Plus size={14} />
              New task
            </Button>
          </>
        }
      >
        <ScopedTitle>Tasks</ScopedTitle>
      </TopBar>
      <div className="page-column list-page">{taskListBody({ error: tasks.error, loading: tasks.isLoading, list, shelf, stage, showProject: !projectId, retry: () => void tasks.refetch() })}</div>
    </>
  );
}

/** Open stages in the list's own group order, so the menu reads like the page. */
const openStages = GROUPS.filter((status) => status !== "done" && status !== "archived");

/** One menu for what the list shows: a shelf, then (on Active) one stage with its count. */
function TaskFilterMenu({
  tasks,
  shelf,
  stage,
  onShelf,
  onStage,
}: {
  tasks: Task[];
  shelf: TaskShelf;
  stage: TaskStatus | null;
  onShelf: (shelf: TaskShelf) => void;
  onStage: (stage: TaskStatus | null) => void;
}) {
  const filtered = shelf !== "active" || stage !== null;
  const name = stage ? statusLabel[stage] : shelfOptions.find((option) => option.value === shelf)!.label;
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={filtered ? `Filter tasks: ${name}` : "Filter tasks"} className={cn(filtered && "text-navigation-ink")} />}>
        <Funnel size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            <Menu.RadioGroup aria-label="Task shelf" value={shelf} onValueChange={(value: TaskShelf) => onShelf(value)}>
              {shelfOptions.map((option) => (
                <Menu.RadioItem key={option.value} value={option.value} className={menuItem} closeOnClick>
                  <Check size={13} className={cn("text-transparent", shelf === option.value && "text-ink")} />
                  <span className="flex-1">{option.label}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            {shelf === "active" ? (
              <>
                <Menu.Separator className={menuSeparator} />
                <Menu.RadioGroup aria-label="Task status" value={stage ?? ""} onValueChange={(value: string) => onStage((value as TaskStatus) || null)}>
                  {[null, ...openStages].map((status) => (
                    <Menu.RadioItem key={status ?? "all"} value={status ?? ""} className={menuItem} closeOnClick>
                      <Check size={13} className={cn("text-transparent", stage === status && "text-ink")} />
                      <span className="flex-1">{status ? statusLabel[status] : "All statuses"}</span>
                      {status ? <span className="text-sm text-ink-4 tabular">{stageCount(tasks, status)}</span> : null}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import type { Task, TaskStatus } from "@openorc/protocol";
import { Check, Funnel, Plus } from "../components/icons";
import { ListGroupHeading } from "../components/ListGroupHeading";
import { HeaderSearch } from "../components/PageFilters";
import { PriorityIcon, StatusIcon, groupLabel, groupOrder, statusLabel, statusOrder } from "../components/status";
import { TopBar } from "../components/TopBar";
import { TaskStart } from "../components/TaskStart";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { Badge, Button, Empty, IconButton, metaSlot } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRpc, useRpcMutation } from "../lib/client";
import { openTask } from "../lib/router";
import { relativeTime } from "@openorc/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { stageCount } from "../lib/task-stage-counts";

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
          title={`Change status · ${statusLabel[task.status]}`}
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

/**
 * Grouped rows with keyboard navigation: j/k or arrows move, Enter opens.
 * The list owns focus so the shortcuts work without clicking first.
 */
export function TaskRows({ tasks, showProject }: { tasks: Task[]; showProject: boolean }) {
  const projects = useRpc("projects.list", {}, { enabled: showProject });
  const nameOf = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";
  const groupId = useId();
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskStatus, boolean>>>({});
  const groups = useMemo(() => groupOrder.map((status) => ({ status, tasks: tasks.filter((t) => t.status === status) })).filter((g) => g.tasks.length > 0), [tasks]);
  const flat = useMemo(() => groups.flatMap((g) => (collapsed[g.status] ? [] : g.tasks)), [groups, collapsed]);
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
      if (t) openTask(t.id);
    }
  };

  let index = -1;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="task-list flex-1 min-h-0 overflow-y-auto outline-none" autoFocus>
        {groups.map(({ status, tasks: group }) => (
          <section key={status} className="list-group" data-status-group={status} aria-labelledby={`${groupId}-${status}-header`}>
            <ListGroupHeading
              id={`${groupId}-${status}-header`}
              controls={`${groupId}-${status}-tasks`}
              collapsed={Boolean(collapsed[status])}
              onToggle={() => setCollapsed((current) => ({ ...current, [status]: !current[status] }))}
              label={groupLabel[status]}
              count={{ value: group.length, label: `${group.length} ${group.length === 1 ? "task" : "tasks"}` }}
            />
            <div id={`${groupId}-${status}-tasks`} hidden={Boolean(collapsed[status])}>
              {group.map((t) => {
                if (!collapsed[status]) index += 1;
                const i = index;
                return (
                  <div key={t.id} data-row={collapsed[status] ? undefined : i}>
                    <div data-current={i === cursor || undefined} data-status={t.status} className="task-list-row">
                      <TaskRowStatus task={t} onMoved={() => listRef.current?.focus({ preventScroll: true })} />
                      <button data-task-open onClick={() => openTask(t.id)} tabIndex={i === cursor ? 0 : -1} onFocus={() => setCursor(i)} aria-label={`${t.title}, ${statusLabel[t.status]}`}>
                        <span className="task-row-title" title={t.title}>
                          {t.title}
                        </span>
                        {t.labels[0] ? <Badge className="task-row-label max-w-24 truncate">{t.labels[0]}</Badge> : null}
                        {showProject ? <span className="task-row-meta task-row-project max-w-28 truncate text-right">{nameOf(t.projectId)}</span> : null}
                        <span className={cn(metaSlot, "task-row-meta task-row-time w-16")}>{relativeTime(t.updatedAt)}</span>
                        <PriorityIcon priority={t.priority} />
                      </button>
                      {t.status === "backlog" || t.status === "proposed" ? <TaskStart task={t} /> : <span className="size-6 shrink-0" aria-hidden="true" />}
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

const shelfOptions = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
] as const;

type TaskShelf = "active" | "done" | "archived";

function taskListBody(input: {
  error: Error | null;
  loading: boolean;
  list: Task[];
  query: string;
  shelf: TaskShelf;
  stage: TaskStatus | null;
  showProject: boolean;
  retry: () => void;
  onNewTask: () => void;
}): ReactNode {
  if (input.error)
    return (
      <Empty title="Tasks couldn’t load">
        <Button onClick={input.retry}>Try again</Button>
      </Empty>
    );
  if (input.loading) return <div className="document-skeleton" aria-label="Loading tasks" />;
  if (input.list.length > 0) return <TaskRows tasks={input.list} showProject={input.showProject} />;
  let title = `No ${input.shelf} tasks`;
  let description = "Tasks appear here when you move them out of your active work.";
  if (input.query) {
    title = "No matching tasks";
    description = "Try a different title or label.";
  } else if (input.stage) {
    title = `No ${statusLabel[input.stage].toLowerCase()} tasks`;
    description = "Choose another status to see the rest of your tasks.";
  } else if (input.shelf === "active") {
    title = "Make room for your next idea";
    description = "Capture the work, shape the details, then bring in an agent.";
  }
  return (
    <Empty title={title}>
      {description}
      {!input.query && !input.stage && input.shelf === "active" ? (
        <div className="mt-4">
          <Button onClick={input.onNewTask}>
            <Plus size={13} /> New task
          </Button>
        </div>
      ) : null}
    </Empty>
  );
}

export function TaskListView({ onNewTask }: { onNewTask: () => void }) {
  const projectId = useLayout((s) => s.projectId);
  const tasks = useRpc("tasks.list", projectId ? { projectId } : {});
  const [query, setQuery] = useState("");
  const [shelf, setShelf] = useState<TaskShelf>("active");
  const all = tasks.data ?? [];
  const [stage, setStage] = useState<TaskStatus | null>(null);
  const list = all.filter(
    (task) =>
      (shelf === "active" ? task.status !== "done" && task.status !== "archived" : task.status === shelf) &&
      (!stage || task.status === stage) &&
      `${task.title} ${task.labels.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <TopBar
        actions={
          <>
            <HeaderSearch label="Search tasks" placeholder="Search tasks…" value={query} onChange={setQuery} />
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
            <Button size="lg" className="ml-1 pl-2.5" onClick={onNewTask}>
              <Plus size={14} className="text-ink-3" />
              New task
            </Button>
          </>
        }
      >
        Tasks
      </TopBar>
      <div className="task-page flex-1 min-h-0 flex flex-col">
        {taskListBody({ error: tasks.error, loading: tasks.isLoading, list, query, shelf, stage, showProject: !projectId, retry: () => void tasks.refetch(), onNewTask })}
      </div>
    </>
  );
}

/** Open stages in the list's own group order, so the menu reads like the page. */
const openStages = groupOrder.filter((status) => status !== "done" && status !== "archived");

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

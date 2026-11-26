import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project } from "@openorc/protocol";
import { relativeTime } from "@openorc/client";
import { useRpc, useRpcMutation } from "../../lib/client";
import { useSpaceProjects } from "../../lib/space-queries";
import { boardSlots, taskBoardColumns, type BoardSlot, type TaskBoardColumn } from "../../lib/task-board";
import { openTaskRecord } from "../../lib/task-open";
import { useTaskProperty } from "../../lib/task-property";
import { taskNeedsAttention, taskNeedsYou, taskRecordKey, type TaskRecord } from "../../lib/task-records";
import { useScrollEdges } from "../../lib/use-scroll-edges";
import { Plus } from "../icons";
import { ProjectLogo } from "../ProjectIconPicker";
import { StatusIcon, statusLabel } from "../status";
import { TaskStart } from "../TaskStart";
import { TaskFacts } from "../task-online/TaskFacts";
import { TaskOnlineOpen } from "../task-online/TaskRowControls";
import { Button, IconButton, StatusDot, Tooltip } from "../ui";
import { TaskBoardColumnSettings } from "./TaskBoardColumnSettings";
import "./task-board.css";

const PAGE = 20;
type LocalRecord = Extract<TaskRecord, { kind: "local" }>;
type OnlineRecord = Extract<TaskRecord, { kind: "online" }>;
/** The card in hand, the column it came from and the column under it. */
type Drag = { key: string; from: string; over: string | null };

/** `projectId` is the one project whose board this is, with its own columns to change. Without one the board is every project's tasks by status. */
export function TaskBoard({ tasks, projectId }: { tasks: TaskRecord[]; projectId: string | null }) {
  const projects = useSpaceProjects(true);
  const kept = useRpc("board.columns", { projectId: projectId ?? "" }, { enabled: Boolean(projectId) });
  const save = useRpcMutation("board.saveColumns");
  const slots = useMemo(() => boardSlots(projectId ? (kept.data ?? []) : []), [projectId, kept.data]);
  const columns = useMemo(() => taskBoardColumns(tasks, projectId ? kept.data : []), [tasks, projectId, kept.data]);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Set by the column a card was let go on. The card reads it as its drag ends, since the way to save a task is the card's own. */
  const dropped = useRef<TaskBoardColumn | null>(null);
  /** The column whose settings are open, by its place, which a save keeps where an unsaved column's id changes. */
  const [settings, setSettings] = useState<number | null>(null);
  const edges = useScrollEdges("x");
  const change = projectId
    ? (next: BoardSlot[], open: number | null) => {
        setSettings(open);
        save.mutate({ projectId, columns: next });
      }
    : null;
  return (
    <div {...edges} className="task-board scroll-edges-x" data-dragging={drag ? "" : undefined}>
      {columns.map((column) => (
        <BoardColumn
          key={column.id}
          column={column}
          accepts={Boolean(drag && drag.from !== column.id)}
          over={drag?.over === column.id}
          onOver={(over) => setDrag((current) => (current && current.over !== over ? { ...current, over } : current))}
          onDrop={() => {
            dropped.current = column;
          }}
          settings={
            change && column.slot !== null ? (
              <TaskBoardColumnSettings slots={slots} index={column.slot} open={settings === column.slot} onOpenChange={(open) => setSettings(open ? column.slot : null)} onChange={change} />
            ) : null
          }
        >
          {(record) => {
            const card = {
              showProject: !projectId,
              project: record.kind === "online" ? record.project : projects.data?.find((project) => project.id === record.task.projectId),
              dragging: drag?.key === taskRecordKey(record),
              onTake: () => setDrag({ key: taskRecordKey(record), from: column.id, over: null }),
              onLetGo: () => {
                const to = dropped.current;
                dropped.current = null;
                setDrag(null);
                return to && to.id !== column.id ? to : null;
              },
            };
            return record.kind === "local" ? <LocalCard key={taskRecordKey(record)} record={record} {...card} /> : <OnlineCard key={taskRecordKey(record)} record={record} {...card} />;
          }}
        </BoardColumn>
      ))}
      {change ? (
        <div className="task-board-add">
          <Tooltip label="Add column">
            <IconButton aria-label="Add column" disabled={save.isPending} onClick={() => change([...slots, { name: "New column", stage: "in_progress" }], slots.length)}>
              <Plus size={16} />
            </IconButton>
          </Tooltip>
          {save.error ? (
            <p role="alert" className="task-board-add-error">
              Couldn’t save the board: {save.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BoardColumn({
  column,
  accepts,
  over,
  onOver,
  onDrop,
  settings,
  children,
}: {
  column: TaskBoardColumn;
  accepts: boolean;
  over: boolean;
  onOver: (column: string | null) => void;
  onDrop: () => void;
  settings: ReactNode;
  children: (record: TaskRecord) => ReactNode;
}) {
  const headingId = useId();
  const [shown, setShown] = useState(PAGE);
  const edges = useScrollEdges();
  const waiting = column.tasks.filter(taskNeedsAttention).length;
  const more = column.tasks.length - shown;
  return (
    <section
      className="task-board-column"
      aria-labelledby={headingId}
      data-over={accepts && over ? "" : undefined}
      onDragOver={(event) => {
        if (!accepts) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onOver(column.id);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOver(null);
      }}
      onDrop={(event) => {
        if (!accepts) return;
        event.preventDefault();
        onDrop();
      }}
    >
      <div className="task-board-column-head">
        <StatusIcon status={column.stage} share={column.share} />
        <h2 id={headingId} className="truncate">
          {column.name}
        </h2>
        {waiting ? (
          <span className="tabular text-attention" aria-label={`${waiting} waiting on you`}>
            {waiting}
          </span>
        ) : null}
        {settings}
      </div>
      <div {...edges} className="task-board-cards scroll-edges">
        {column.tasks.slice(0, shown).map(children)}
        {more > 0 ? (
          <button type="button" className="task-board-more" onClick={() => setShown(shown + PAGE)}>
            Show {Math.min(PAGE, more)} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

type CardProps = {
  showProject: boolean;
  project: Project | undefined;
  dragging: boolean;
  onTake: () => void;
  /** Ends the drag and answers with the column the card was dropped on, if it was dropped on another one. */
  onLetGo: () => TaskBoardColumn | null;
};

function LocalCard({ record, ...card }: CardProps & { record: LocalRecord }) {
  const update = useRpcMutation("tasks.update");
  return (
    <BoardCard
      {...card}
      record={record}
      movable={!update.isPending}
      error={update.error ? `Couldn’t move: ${update.error.message}` : null}
      move={(column) => update.mutate({ id: record.task.id, patch: column.kept ? { columnId: column.kept.id } : { status: column.stage } })}
      start={<TaskStart task={record.task} />}
    />
  );
}

/** An organization's task knows its status and no column yet, so it lands in the first column of the stage it was dropped on. */
function OnlineCard({ record, ...card }: CardProps & { record: OnlineRecord }) {
  const update = useTaskProperty(record.reference, record.task);
  return (
    <BoardCard
      {...card}
      record={record}
      movable={record.task.viewer.mayEdit && !update.pending}
      error={update.state.propertyError}
      move={(column) => void update.controller.property({ status: column.stage })}
      start={<TaskOnlineOpen task={record.task} reference={record.reference} />}
    />
  );
}

function BoardCard({
  record,
  showProject,
  project,
  dragging,
  onTake,
  onLetGo,
  movable,
  error,
  move,
  start,
}: CardProps & { record: TaskRecord; movable: boolean; error: string | null; move: (column: TaskBoardColumn) => void; start: ReactNode }) {
  const task = record.task;
  const needsYou = taskNeedsYou(record);
  const waits = task.status === "backlog" || task.status === "proposed";
  return (
    <article
      className="task-board-card"
      data-stage={task.status}
      data-dragging={dragging ? "" : undefined}
      draggable={movable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.title);
        onTake();
      }}
      onDragEnd={() => {
        const column = onLetGo();
        if (column) move(column);
      }}
    >
      <button type="button" className="task-board-card-open" onClick={() => openTaskRecord(record)} aria-label={`${task.title}, ${needsYou ? "needs your approval" : statusLabel[task.status]}`}>
        {task.title}
      </button>
      <div className="task-board-card-meta">
        {needsYou ? (
          <span className="task-board-card-fact text-attention">
            <StatusDot tone="attention" />
            Needs you
          </span>
        ) : null}
        {!needsYou && task.labels[0] ? (
          <span className="task-board-card-fact">
            <StatusDot tone="muted" />
            <span className="truncate">{task.labels[0]}</span>
          </span>
        ) : null}
        {showProject && project ? (
          <span className="task-board-card-fact">
            <ProjectLogo project={project} />
            <span className="truncate">{project.name}</span>
          </span>
        ) : null}
        {record.kind === "online" ? <TaskFacts task={record.task} cloud={!(showProject && project && !project.rootPath && "cloud" in project && project.cloud)} /> : null}
        <span className="task-board-card-end">
          {task.status === "review" ? (
            <Button size="sm" onClick={() => openTaskRecord(record, "files")}>
              Review
            </Button>
          ) : (
            <span className="tabular text-ink-4">{relativeTime(task.updatedAt)}</span>
          )}
          {waits ? start : null}
        </span>
      </div>
      {error ? (
        <p role="alert" className="task-board-card-error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

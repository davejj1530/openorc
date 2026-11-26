import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { BoardColumnJob, Project } from "@openorc/protocol";
import { relativeTime } from "@openorc/client";
import { useRpcMutation } from "../../lib/client";
import { useSpaceProjects } from "../../lib/space-queries";
import { agentSetupSlot, asksForRunner, boardMove, type BoardKeeper, type BoardSlot, type TaskBoardColumn } from "../../lib/task-board";
import { useTaskOnlineScope } from "../../lib/task-online-query";
import { columnKey, type UnionColumn } from "../../lib/task-board-union";
import { boardKeeper, boardProjectKey, columnAgents, useBoardColumns, type BoardOwner } from "../../lib/task-board-source";
import { openTaskRecord } from "../../lib/task-open";
import { useTaskProperty } from "../../lib/task-property";
import { taskNeedsAttention, taskNeedsYou, taskRecordKey, type TaskRecord } from "../../lib/task-records";
import { useTasksView } from "../../lib/tasks-view";
import { useScrollEdges } from "../../lib/use-scroll-edges";
import { HarnessLogo } from "../HarnessLogo";
import { Automation, Plus } from "../icons";
import { ProjectLogo } from "../ProjectIconPicker";
import { StatusIcon, statusLabel } from "../status";
import { TaskStart } from "../TaskStart";
import { TaskFacts } from "../task-online/TaskFacts";
import { TaskOnlineOpen } from "../task-online/TaskRowControls";
import { Button, IconButton, StatusDot, Tooltip } from "../ui";
import { TaskBoardColumnSettings, type ColumnAcross } from "./TaskBoardColumnSettings";
import { RunFact, RunHereAsk } from "./TeamRun";
import "./task-board.css";

const PAGE = 20;
type LocalRecord = Extract<TaskRecord, { kind: "local" }>;
type OnlineRecord = Extract<TaskRecord, { kind: "online" }>;
/** The card in hand, the column it came from and the column under it. */
type Drag = { key: string; from: string; over: string | null };

/** The card open beside the board, by its task, and what a press on a card kept on this computer does. */
export type BoardPane = { id: string; opened: string | null; onOpen: (taskId: string) => void };

/** The column whose settings are open: by its place, and on the board of all projects by its name, since a change there can move it. */
type OpenSettings = { place: number; name: string };

/** Where the open settings' column is now: its name found on the board of all projects, else its place. */
function settingsPlace(open: OpenSettings | null, slots: readonly BoardSlot[], byName: boolean): number | null {
  if (!open) return null;
  const found = byName ? slots.findIndex((slot) => columnKey(slot.name) === columnKey(open.name)) : -1;
  return found < 0 ? open.place : found;
}

/**
 * `owner` keeps the columns this board shows and changes: this computer, for a project in a folder here, the project's
 * organization, which shares them, or, on the board of all projects, every project here, whose columns it shows as one
 * union. Without one the board is its tasks by status. `showProject` names each card's project, on a board of several.
 */
export function TaskBoard({ tasks, owner, showProject, pane }: { tasks: TaskRecord[]; owner: BoardOwner | null; showProject: boolean; pane: BoardPane }) {
  const projects = useSpaceProjects(true);
  const board = useBoardColumns(owner);
  const keeper: BoardKeeper = boardKeeper(owner);
  const cloudRuns = useTaskOnlineScope().availability?.runsCloud ?? { available: false, reason: null };
  const { slots, columnsFor } = board;
  const key = owner ? boardProjectKey(owner) : null;
  const project = key ? projects.data?.find((each) => each.id === key) : undefined;
  const columns = useMemo(() => columnsFor(tasks), [columnsFor, tasks]);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Set by the column a card was let go on. The card reads it as its drag ends, since the way to save a task is the card's own. */
  const dropped = useRef<TaskBoardColumn | null>(null);
  /** The column whose settings are open, which a save keeps open where an unsaved column's id changes. */
  const [opened, setOpened] = useState<OpenSettings | null>(null);
  const settings = settingsPlace(opened, slots, Boolean(board.union));
  const openAt = (next: readonly BoardSlot[], place: number | null) => setOpened(place === null ? null : { place, name: next[place]?.name ?? "" });
  const edges = useScrollEdges("x");
  useAgentSetup(owner, board.ready, slots, setOpened);
  const change = board.editable
    ? (next: BoardSlot[], open: number | null) => {
        openAt(next, open);
        board.save(next);
      }
    : null;
  const names = (ids: readonly string[]) => ids.map((id) => (owner?.place === "team-union" ? owner.names.get(id) : projects.data?.find((each) => each.id === id)?.name) ?? "A project");
  return (
    <>
      {board.notice ? <BoardNotice {...board.notice} /> : null}
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
            job={column.job ?? null}
            settings={
              change && column.slot !== null ? (
                <TaskBoardColumnSettings
                  slots={slots}
                  index={column.slot}
                  project={project}
                  jobsStart={columnAgents(owner)}
                  shared={keeper === "online"}
                  cloudRuns={cloudRuns}
                  across={board.union ? unionNote(board.union[column.slot], names, owner) : null}
                  open={settings === column.slot}
                  onOpenChange={(open) => openAt(slots, open ? column.slot : null)}
                  onChange={change}
                />
              ) : null
            }
          >
            {(record) => {
              const key = taskRecordKey(record);
              const card = {
                showProject,
                project: record.kind === "online" ? record.project : projects.data?.find((project) => project.id === record.task.projectId),
                keeper,
                dragging: drag?.key === key,
                onTake: () => setDrag({ key, from: column.id, over: null }),
                onLetGo: () => {
                  const to = dropped.current;
                  dropped.current = null;
                  setDrag(null);
                  return to && to.id !== column.id ? to : null;
                },
              };
              return record.kind === "local" ? <LocalCard key={key} record={record} pane={pane} {...card} /> : <OnlineCard key={key} record={record} pane={pane} {...card} />;
            }}
          </BoardColumn>
        ))}
        {change ? (
          <div className="task-board-add">
            <Tooltip label="Add column">
              <IconButton aria-label="Add column" disabled={board.saving || board.full} onClick={() => change([...slots, { name: "New column", stage: "in_progress" }], slots.length)}>
                <Plus size={16} />
              </IconButton>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** Opens the settings of the column the Automations page asked for, once this board is that project's and its columns are read. */
function useAgentSetup(owner: BoardOwner | null, ready: boolean, slots: readonly BoardSlot[], open: (settings: OpenSettings) => void): void {
  const setup = useTasksView((state) => state.agentSetup);
  useEffect(() => {
    if (!setup || owner?.place !== "local" || owner.projectId !== setup.projectId || !ready) return;
    const place = agentSetupSlot(slots, setup.columnId);
    open({ place, name: slots[place]?.name ?? "" });
    useTasksView.getState().setUpAgent(null);
  }, [setup, owner, ready, slots, open]);
}

/** What a column of the board of all projects is across them: the projects that have it, and those whose agent differs. */
function unionNote(column: UnionColumn | undefined, names: (ids: readonly string[]) => string[], owner: BoardOwner | null): ColumnAcross | null {
  if (!column || (owner?.place !== "union" && owner?.place !== "team-union")) return null;
  const having = column.members.map((member) => member.projectId);
  return { having: having.length === owner.projectIds.length ? null : names(having), agentDiffers: names(column.jobsDiffer), sole: column.sole };
}

/**
 * What became of a save, over the board where it is in view however far the board is scrolled: why it failed, in the
 * bad ink, or that another person's save came first and the board shows theirs.
 */
function BoardNotice({ text, failed }: { text: string; failed: boolean }) {
  return (
    <p role={failed ? "alert" : "status"} className={cn("task-board-notice", failed && "text-bad")}>
      {text}
    </p>
  );
}

function BoardColumn({
  column,
  accepts,
  over,
  onOver,
  onDrop,
  job,
  settings,
  children,
}: {
  column: TaskBoardColumn;
  /** What starts for a card put here, shown as its agent's mark, or the automation mark when it runs on the task's own model. */
  job: BoardColumnJob | null;
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
        {job ? (
          <span className="task-board-column-job" data-tip="Starts an agent for each card">
            {job.choice ? <HarnessLogo id={job.choice.agent} size={14} /> : <Automation size={14} />}
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
  /** Which kind of task the board's own columns hold; a card of the other kind moves by its status. */
  keeper: BoardKeeper;
  project: Project | undefined;
  dragging: boolean;
  onTake: () => void;
  /** Ends the drag and answers with the column the card was dropped on, if it was dropped on another one. */
  onLetGo: () => TaskBoardColumn | null;
};

/** A task kept on this computer opens beside the board. */
function LocalCard({ record, pane, keeper, ...card }: CardProps & { record: LocalRecord; pane: BoardPane }) {
  const update = useRpcMutation("tasks.update");
  return (
    <BoardCard
      {...card}
      record={record}
      opens={{ id: pane.id, open: pane.opened === taskRecordKey(record) }}
      onOpen={() => pane.onOpen(taskRecordKey(record))}
      movable={!update.isPending}
      error={update.error ? `Couldn’t move: ${update.error.message}` : null}
      move={(column) => update.mutate({ id: record.task.id, patch: boardMove(record, column, keeper) })}
      start={<TaskStart task={record.task} />}
    />
  );
}

/**
 * An organization's task goes into its organization's shared column, or by its status on a board this computer keeps.
 * Its card opens it beside the board. Put in a column whose agent nobody could run, it asks the person to run it.
 */
function OnlineCard({ record, pane, keeper, ...card }: CardProps & { record: OnlineRecord; pane: BoardPane }) {
  const update = useTaskProperty(record.reference, record.task);
  const runs = Boolean(useTaskOnlineScope().availability?.runs);
  const [asking, setAsking] = useState<TaskBoardColumn | null>(null);
  const place = (column: TaskBoardColumn, runHere?: true) => void update.controller.property(boardMove(record, column, keeper), runHere ? { runHere } : {});
  const answer = (runHere?: true) => {
    if (asking) place(asking, runHere);
    setAsking(null);
  };
  return (
    <>
      <BoardCard
        {...card}
        record={record}
        opens={{ id: pane.id, open: pane.opened === taskRecordKey(record) }}
        onOpen={() => pane.onOpen(taskRecordKey(record))}
        movable={record.task.viewer.mayEdit && !update.pending}
        error={update.state.propertyError}
        move={(column) => (asksForRunner(record, column, runs) ? setAsking(column) : place(column))}
        start={<TaskOnlineOpen task={record.task} reference={record.reference} />}
      />
      {asking ? <RunHereAsk cloud={asking.job?.where === "cloud"} onRun={() => answer(true)} onMove={() => answer()} onCancel={() => setAsking(null)} /> : null}
    </>
  );
}

/** What a card says under its title: that it waits on the person, else its first label, or its project on a board of several; and an organization task's own facts. */
function CardFacts({ record, needsYou, showProject, project }: { record: TaskRecord; needsYou: boolean; showProject: boolean; project: Project | undefined }) {
  const task = record.task;
  return (
    <>
      {needsYou ? (
        <span className="task-board-card-fact text-attention">
          <StatusDot tone="attention" />
          Needs you
        </span>
      ) : null}
      {/* A board of every project names each card's project, and a label has no room beside it. */}
      {!needsYou && !showProject && task.labels[0] ? (
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
      {record.kind === "online" ? <RunFact task={record.task} /> : null}
      {record.kind === "online" ? <TaskFacts task={record.task} cloud={!(showProject && project && !project.rootPath && "cloud" in project && project.cloud)} /> : null}
    </>
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
  opens,
  onOpen,
}: Omit<CardProps, "keeper"> & {
  record: TaskRecord;
  movable: boolean;
  error: string | null;
  move: (column: TaskBoardColumn) => void;
  start: ReactNode;
  /** The pane a press on the card opens, and whether this card's task is the one in it. */
  opens?: { id: string; open: boolean };
  onOpen: () => void;
}) {
  const task = record.task;
  const needsYou = taskNeedsYou(record);
  const waits = task.status === "backlog" || task.status === "proposed";
  return (
    <article
      className="task-board-card"
      data-stage={task.status}
      data-dragging={dragging ? "" : undefined}
      data-open={opens?.open ? "" : undefined}
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
      <button
        type="button"
        className="task-board-card-open"
        onClick={onOpen}
        aria-controls={opens?.id}
        aria-expanded={opens?.open}
        aria-label={`${task.title}, ${needsYou ? "needs your approval" : statusLabel[task.status]}`}
      >
        {task.title}
      </button>
      <div className="task-board-card-meta">
        <CardFacts record={record} needsYou={needsYou} showProject={showProject} project={project} />
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

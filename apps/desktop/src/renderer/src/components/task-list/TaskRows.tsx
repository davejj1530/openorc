import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Project } from "@openorc/protocol";
import { useSpaceProjects } from "../../lib/space-queries";
import { openTaskRecord } from "../../lib/task-open";
import { taskNeedsAttention, taskRecordKey, type TaskRecord } from "../../lib/task-records";
import { heldTaskGroups, taskGroups, waitingTaskGroups, type TaskGroupKey, type TaskGroup } from "../../lib/task-groups";
import { keepTaskListScroll, taskListScroll } from "../../lib/task-list-state";
import { useListHold } from "../../lib/use-list-hold";
import { ListGroupHeading } from "../ListGroupHeading";
import { TaskListRow } from "./TaskListRow";

export function TaskRows({ tasks, showProject, memoryKey }: { tasks: TaskRecord[]; showProject: boolean; memoryKey: string | null }) {
  const projects = useSpaceProjects(true);
  const groupId = useId();
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskGroupKey, boolean>>>({});
  const hold = useListHold();
  const live = useMemo(() => taskGroups(tasks), [tasks]);
  const previous = useRef(live);
  const groups = memoryKey && hold.held ? heldTaskGroups(previous.current, tasks) : live;
  useEffect(() => {
    previous.current = groups;
  }, [groups]);
  const flat = useMemo(() => groups.flatMap((g) => (collapsed[g.key] ? [] : g.tasks)), [groups, collapsed]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cursor >= flat.length) setCursor(Math.max(0, flat.length - 1));
  }, [flat.length, cursor]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  useLayoutEffect(() => {
    if (memoryKey && listRef.current) listRef.current.scrollTop = taskListScroll(memoryKey);
  }, [memoryKey]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest("[data-task-open]")) return;
    if (flat.length === 0) return;
    if (["ArrowDown", "j", "ArrowUp", "k"].includes(e.key)) {
      e.preventDefault();
      const delta = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      setCursor((current) => Math.min(flat.length - 1, Math.max(0, current + delta)));
      listRef.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[cursor];
      if (row) openTaskRecord(row);
    }
  };
  const indices = new Map(flat.map((record, index) => [taskRecordKey(record), index]));
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="task-list flex-1 min-h-0 overflow-y-auto outline-none"
        autoFocus
        {...(memoryKey ? hold.props : {})}
        onScroll={(event) => {
          if (memoryKey) keepTaskListScroll(memoryKey, event.currentTarget.scrollTop);
        }}
      >
        {groups.map((group) => (
          <TaskGroupRows
            key={group.key}
            group={group}
            groupId={groupId}
            collapsed={Boolean(collapsed[group.key])}
            toggle={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))}
            indices={indices}
            cursor={cursor}
            setCursor={setCursor}
            listRef={listRef}
            showProject={showProject}
            projects={projects.data ?? []}
          />
        ))}
      </div>
    </div>
  );
}

function TaskGroupRows({
  group,
  groupId,
  collapsed,
  toggle,
  indices,
  cursor,
  setCursor,
  listRef,
  showProject,
  projects,
}: {
  group: TaskGroup;
  groupId: string;
  collapsed: boolean;
  toggle: () => void;
  indices: Map<string, number>;
  cursor: number;
  setCursor: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
  showProject: boolean;
  projects: Project[];
}) {
  const waiting = group.tasks.filter(taskNeedsAttention).length;
  return (
    <section className="list-group" data-status-group={group.key} aria-labelledby={`${groupId}-${group.key}-header`}>
      <ListGroupHeading
        id={`${groupId}-${group.key}-header`}
        controls={`${groupId}-${group.key}-tasks`}
        collapsed={collapsed}
        onToggle={toggle}
        label={group.label}
        count={waitingTaskGroups.includes(group.key) && waiting ? { value: waiting, label: `${waiting} waiting on you`, waiting: true } : null}
      />
      <div id={`${groupId}-${group.key}-tasks`} hidden={collapsed}>
        {group.tasks.map((record) => {
          const index = indices.get(taskRecordKey(record)) ?? -1;
          const project = record.kind === "online" ? record.project : projects.find((project) => project.id === record.task.projectId);
          return (
            <div key={taskRecordKey(record)} data-row={collapsed ? undefined : index}>
              <TaskListRow
                record={record}
                project={project}
                showProject={showProject}
                current={index === cursor}
                onFocus={() => setCursor(index)}
                onMoved={() => listRef.current?.focus({ preventScroll: true })}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

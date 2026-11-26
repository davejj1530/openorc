import { Fragment, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { TaskStatus, type Project } from "@openorc/protocol";
import { cn } from "../../lib/cn";
import { CoversPreview } from "../../lib/browser-preview";
import { floatingGround } from "../../lib/use-anchor-ground";
import { taskGroupOrder } from "../../lib/task-groups";
import type { TaskShelf } from "../../lib/task-list-state";
import type { TaskRecord } from "../../lib/task-records";
import { Check, Funnel } from "../icons";
import { menuItem, menuPopup, menuSeparator } from "../menu";
import { statusLabel } from "../status";
import { IconButton } from "../ui";

const shelves = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
] as const;
type ShelfFilter = { tasks: TaskRecord[]; shelf: TaskShelf; stage: TaskStatus | null; onShelf(value: TaskShelf): void; onStage(value: TaskStatus | null): void };
type FilterProps = {
  /** The list's choice of shelf and status. The board draws each status as a column and leaves it out. */
  shelves?: ShelfFilter;
  assignment?: { value: boolean; onChange(value: boolean): void };
  project?: { id: string | null; projects: Project[]; onChange(id: string | null): void };
};

function filterName({ shelves: chosen, assignment }: FilterProps): string | null {
  if (chosen?.stage) return statusLabel[chosen.stage];
  if (chosen && chosen.shelf !== "active") return shelves.find((option) => option.value === chosen.shelf)!.label;
  return assignment?.value ? "Assigned to me" : null;
}

/** Every way the screen's tasks can be narrowed, a hairline between kinds. Nothing to narrow by draws no menu. */
export function TaskFilterMenu(props: FilterProps) {
  const name = filterName(props);
  const groups: ReactNode[] = [
    props.assignment ? <TaskAssignmentFilter key="assignment" assignment={props.assignment} /> : null,
    props.shelves ? <TaskShelfFilter key="shelf" {...props.shelves} /> : null,
    props.project ? <TaskProjectFilter key="project" project={props.project} /> : null,
    props.shelves?.shelf === "active" ? <TaskStageFilter key="stage" {...props.shelves} /> : null,
  ].filter(Boolean);
  if (groups.length === 0) return null;
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={name ? `Filter tasks: ${name}` : "Filter tasks"} className={cn(name && "text-navigation-ink")} />}>
        <Funnel size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {groups.map((group, index) => (
              <Fragment key={index}>
                {index > 0 ? <Menu.Separator className={menuSeparator} /> : null}
                {group}
              </Fragment>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function TaskAssignmentFilter({ assignment }: { assignment: NonNullable<FilterProps["assignment"]> }) {
  return (
    <Menu.CheckboxItem className={menuItem} checked={assignment.value} onCheckedChange={assignment.onChange} closeOnClick>
      <Check size={13} className={cn("text-transparent", assignment.value && "text-ink")} />
      <span className="flex-1">Assigned to me</span>
    </Menu.CheckboxItem>
  );
}

function TaskShelfFilter({ shelf, onShelf }: Pick<ShelfFilter, "shelf" | "onShelf">) {
  return (
    <Menu.RadioGroup aria-label="Task shelf" value={shelf} onValueChange={(value: TaskShelf) => onShelf(value)}>
      {shelves.map((option) => (
        <Menu.RadioItem key={option.value} value={option.value} className={menuItem} closeOnClick>
          <Check size={13} className={cn("text-transparent", shelf === option.value && "text-ink")} />
          <span className="flex-1">{option.label}</span>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

function TaskProjectFilter({ project }: { project: NonNullable<FilterProps["project"]> }) {
  return (
    <Menu.RadioGroup aria-label="Task project" value={project.id ?? ""} onValueChange={(value: string) => project.onChange(value || null)}>
      {[{ id: "", name: "All projects" }, ...project.projects].map((row) => (
        <Menu.RadioItem key={row.id} value={row.id} className={menuItem} closeOnClick>
          <Check size={13} className={cn("text-transparent", (project.id ?? "") === row.id && "text-ink")} />
          <span className="flex-1">{row.name}</span>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

function TaskStageFilter({ tasks, stage, onStage }: Pick<ShelfFilter, "tasks" | "stage" | "onStage">) {
  return (
    <Menu.RadioGroup aria-label="Task status" value={stage ?? ""} onValueChange={(value: string) => onStage(value ? TaskStatus.parse(value) : null)}>
      {[null, ...taskGroupOrder.filter((status) => status !== "done" && status !== "archived")].map((status) => (
        <Menu.RadioItem key={status ?? "all"} value={status ?? ""} className={menuItem} closeOnClick>
          <Check size={13} className={cn("text-transparent", stage === status && "text-ink")} />
          <span className="flex-1">{status ? statusLabel[status] : "All statuses"}</span>
          {status ? <span className="text-sm text-ink-4 tabular">{tasks.filter((record) => record.task.status === status).length}</span> : null}
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

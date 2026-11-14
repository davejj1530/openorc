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
type FilterProps = {
  tasks: TaskRecord[];
  shelf: TaskShelf;
  stage: TaskStatus | null;
  onShelf(value: TaskShelf): void;
  onStage(value: TaskStatus | null): void;
  assignment?: { value: boolean; onChange(value: boolean): void };
  project?: { id: string | null; projects: Project[]; onChange(id: string | null): void };
};

export function TaskFilterMenu(props: FilterProps) {
  const filtered = props.shelf !== "active" || props.stage !== null || props.assignment?.value;
  const name = props.stage ? statusLabel[props.stage] : shelves.find((option) => option.value === props.shelf)!.label;
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={filtered ? `Filter tasks: ${name}` : "Filter tasks"} className={cn(filtered && "text-navigation-ink")} />}>
        <Funnel size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {props.assignment ? (
              <>
                <Menu.CheckboxItem className={menuItem} checked={props.assignment.value} onCheckedChange={props.assignment.onChange} closeOnClick>
                  <Check size={13} className={cn("text-transparent", props.assignment.value && "text-ink")} />
                  <span className="flex-1">Assigned to me</span>
                </Menu.CheckboxItem>
                <Menu.Separator className={menuSeparator} />
              </>
            ) : null}
            <Menu.RadioGroup aria-label="Task shelf" value={props.shelf} onValueChange={(value: TaskShelf) => props.onShelf(value)}>
              {shelves.map((option) => (
                <Menu.RadioItem key={option.value} value={option.value} className={menuItem} closeOnClick>
                  <Check size={13} className={cn("text-transparent", props.shelf === option.value && "text-ink")} />
                  <span className="flex-1">{option.label}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            {props.project ? <TaskProjectFilter project={props.project} /> : null}
            {props.shelf === "active" ? <TaskStageFilter tasks={props.tasks} stage={props.stage} onStage={props.onStage} /> : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function TaskProjectFilter({ project }: { project: NonNullable<FilterProps["project"]> }) {
  return (
    <>
      <Menu.Separator className={menuSeparator} />
      <Menu.RadioGroup aria-label="Task project" value={project.id ?? ""} onValueChange={(value: string) => project.onChange(value || null)}>
        {[{ id: "", name: "All projects" }, ...project.projects].map((row) => (
          <Menu.RadioItem key={row.id} value={row.id} className={menuItem} closeOnClick>
            <Check size={13} className={cn("text-transparent", (project.id ?? "") === row.id && "text-ink")} />
            <span className="flex-1">{row.name}</span>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </>
  );
}

function TaskStageFilter({ tasks, stage, onStage }: Pick<FilterProps, "tasks" | "stage" | "onStage">) {
  return (
    <>
      <Menu.Separator className={menuSeparator} />
      <Menu.RadioGroup aria-label="Task status" value={stage ?? ""} onValueChange={(value: string) => onStage(value ? TaskStatus.parse(value) : null)}>
        {[null, ...taskGroupOrder.filter((status) => status !== "done" && status !== "archived")].map((status) => (
          <Menu.RadioItem key={status ?? "all"} value={status ?? ""} className={menuItem} closeOnClick>
            <Check size={13} className={cn("text-transparent", stage === status && "text-ink")} />
            <span className="flex-1">{status ? statusLabel[status] : "All statuses"}</span>
            {status ? <span className="text-sm text-ink-4 tabular">{tasks.filter((record) => record.task.status === status).length}</span> : null}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </>
  );
}

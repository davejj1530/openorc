import { Menu } from "@base-ui/react/menu";
import { READY_MADE_AUTOMATIONS, harnessShortName, type Automation, type BoardColumn, type Project, type ReadyMadeAutomation } from "@openorc/protocol";
import { HarnessLogo } from "../components/HarnessLogo";
import { Automation as AutomationMark, CalendarClock, Columns2, Plus } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { Button, Switch } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpcMutation } from "../lib/client";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { useTasksView } from "../lib/tasks-view";
import { floatingGround } from "../lib/use-anchor-ground";
import { TriggerMark } from "../components/automations/TriggerMark";
import "./schedules.css";

/** A project's board, where its columns and their jobs are changed. */
export function openBoard(projectId: string | null): void {
  const layout = useLayout.getState();
  if (projectId) layout.setWorkspace(projectId);
  useTasksView.getState().setView("board");
  useRouter.getState().navigate({ view: "tasks" });
}

/** A column's agent among the automations: the column a card arrives in, the model it runs on, and its switch. It opens the board it belongs to. */
export function ColumnJobRow({ column, projectName }: { column: BoardColumn; projectName?: string | undefined }) {
  const flip = useRpcMutation("board.switchJob");
  const agent = column.job?.choice?.agent;
  return (
    <div data-job={column.id} className="schedule-row">
      <div className="schedule-row-line">
        <button type="button" onClick={() => openBoard(column.projectId)} className="schedule-row-open">
          <span className="schedule-row-well" aria-hidden="true">
            {agent ? <HarnessLogo id={agent} size={16} /> : <Columns2 size={16} />}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="schedule-row-name truncate">{column.name}</span>
            <span className="schedule-when truncate">{["When a card arrives", agent ? harnessShortName(agent) : null, projectName].filter(Boolean).join(" · ")}</span>
          </span>
        </button>
        <span className="schedule-row-next tabular text-ink-3">{column.jobEnabled ? "" : "Paused"}</span>
        <Switch
          aria-label={column.jobEnabled ? `Pause ${column.name}` : `Resume ${column.name}`}
          checked={column.jobEnabled}
          disabled={flip.isPending}
          onChange={() => flip.mutate({ columnId: column.id, enabled: !column.jobEnabled })}
        />
      </div>
      {flip.error ? (
        <p className="schedule-row-note text-bad" role="alert">
          {flip.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** New automation, as a menu of the three ways one is made: a rule, a column's agent on the board, or a prompt on a timer. */
export function NewAutomationMenu({ disabled, onRule, onBoard, onSchedule }: { disabled: boolean; onRule: () => void; onBoard: () => void; onSchedule: () => void }) {
  const ways = [
    { label: "When something happens", go: onRule },
    { label: "When a card arrives in a column", go: onBoard },
    { label: "On a schedule", go: onSchedule },
  ];
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button variant="primary" size="lg" className="pl-2.5" disabled={disabled} />}>
        <Plus size={16} /> New automation
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {ways.map((way) => (
              <Menu.Item key={way.label} className={menuItem} onClick={way.go}>
                <span className="flex-1">{way.label}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ReadyMadeMark({ made }: { made: ReadyMadeAutomation }) {
  if (made.kind === "rule") return <TriggerMark trigger={made.trigger} />;
  return made.kind === "schedule" ? <CalendarClock size={16} /> : <AutomationMark size={16} />;
}

type Board = Extract<ReadyMadeAutomation, { kind: "board" }>;
type Timed = Extract<ReadyMadeAutomation, { kind: "schedule" }>;
type Rule = Extract<ReadyMadeAutomation, { kind: "rule" }>;

type BoardActionProps = { made: Board; added: boolean; projectId: string | null; projects: readonly Project[]; onAdd: (projectId: string) => void; disabled: boolean };

/** Add for one that goes on a board: at once on the project in scope, else on the project chosen from a menu. One the board already has says so. */
function BoardAction({ made, added, projectId, projects, onAdd, disabled }: BoardActionProps) {
  if (added) return <span className="text-xs text-ink-4">Added</span>;
  if (projectId)
    return (
      <Button size="sm" disabled={disabled} onClick={() => onAdd(projectId)}>
        Add
      </Button>
    );
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" disabled={disabled || projects.length === 0} aria-label={`Add ${made.name} to a project`} />}>Add</Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {projects.map((project) => (
              <Menu.Item key={project.id} className={menuItem} onClick={() => onAdd(project.id)}>
                <span className="flex-1">{project.name}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The automations the app offers ready to add, as cards of one size. One for the board adds its columns to a project's
 * board; a rule or one on a timer opens its form already filled in, for its project and model to be chosen.
 */
export function ReadyMadeAutomations({
  projectId,
  projects,
  jobs,
  rules,
  onSchedule,
  onRule,
}: {
  projectId: string | null;
  /** The projects a board automation can be added to: the ones with a folder on this Mac. */
  projects: readonly Project[];
  /** The columns that start an agent, to say which ready-made ones a board already has. */
  jobs: readonly BoardColumn[];
  /** The automations already kept, to say which ready-made rules the project in scope has. */
  rules: readonly Automation[];
  onSchedule: (made: Timed) => void;
  onRule: (made: Rule) => void;
}) {
  const add = useRpcMutation("board.addReadyMade");
  const onBoard = (made: Board) => Boolean(projectId) && made.columns.every((column) => jobs.some((job) => job.projectId === projectId && job.name.toLowerCase() === column.name.toLowerCase()));
  const kept = (made: Rule) => Boolean(projectId) && rules.some((rule) => rule.projectId === projectId && rule.name === made.name);
  const action = (made: ReadyMadeAutomation) => {
    if (made.kind === "board")
      return <BoardAction made={made} added={onBoard(made)} projectId={projectId} projects={projects} disabled={add.isPending} onAdd={(id) => add.mutate({ projectId: id, id: made.id })} />;
    if (made.kind === "rule" && kept(made)) return <span className="text-xs text-ink-4">Added</span>;
    return (
      <Button size="sm" onClick={() => (made.kind === "rule" ? onRule(made) : onSchedule(made))}>
        Add
      </Button>
    );
  };
  return (
    <section aria-labelledby="automation-ready-heading">
      <h2 id="automation-ready-heading" className="automation-heading">
        Ready-made
      </h2>
      <div className="automation-ready">
        {READY_MADE_AUTOMATIONS.map((made) => (
          <article key={made.id} className="automation-ready-card">
            <div className="automation-ready-top">
              <span className="schedule-row-well" aria-hidden="true">
                <ReadyMadeMark made={made} />
              </span>
              {action(made)}
            </div>
            <h3 className="automation-ready-name">{made.name}</h3>
            <p className="automation-ready-what">{made.what}</p>
          </article>
        ))}
      </div>
      {add.error ? (
        <p className="mt-2 text-sm text-bad" role="alert">
          {add.error.message}
        </p>
      ) : null}
    </section>
  );
}

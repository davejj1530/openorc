import { Popover } from "@base-ui/react/popover";
import { stepsWords, triggerWords } from "@openorc/client";
import { READY_MADE_AUTOMATIONS, harnessShortName, triggerHasTask, type Automation, type BoardColumn, type ReadyMadeAutomation, type Task } from "@openorc/protocol";
import { useState, type ReactNode } from "react";
import { CoversPreview } from "../../lib/browser-preview";
import type { RulePreset } from "../../lib/automation-draft";
import { useRpc, useRpcMutation } from "../../lib/client";
import { floatingGround } from "../../lib/use-anchor-ground";
import { HarnessLogo } from "../HarnessLogo";
import { Automation as AutomationMark, Columns2, Plus } from "../icons";
import { Button, IconButton, Switch, Tooltip } from "../ui";
import { AutomationDialog } from "./AutomationDialog";
import { TriggerMark } from "./TriggerMark";
import "./automations.css";

type Editing = { automation: Automation | null; preset?: RulePreset };

/** One line of the menu: a mark, a name with what it does under it, and its switch or its Add at the end. */
function MenuLine({ mark, name, what, onOpen, children }: { mark: ReactNode; name: string; what: string; onOpen?: () => void; children: ReactNode }) {
  const words = (
    <>
      <span className="automations-menu-name truncate">{name}</span>
      <span className="automations-menu-what">{what}</span>
    </>
  );
  return (
    <li className="automations-menu-line">
      <span className="automations-menu-mark" aria-hidden="true">
        {mark}
      </span>
      {onOpen ? (
        <button type="button" className="automations-menu-words" onClick={onOpen}>
          {words}
        </button>
      ) : (
        <span className="automations-menu-words">{words}</span>
      )}
      {children}
    </li>
  );
}

function RuleLine({ automation, columns, onTask, onEdit }: { automation: Automation; columns: readonly BoardColumn[]; onTask: boolean; onEdit: () => void }) {
  const flip = useRpcMutation("automations.switch");
  return (
    <MenuLine mark={<TriggerMark trigger={automation.trigger} />} name={automation.name} what={`${triggerWords(automation.trigger, onTask)} · ${stepsWords(automation, columns)}`} onOpen={onEdit}>
      <Switch
        aria-label={automation.enabled ? `Pause ${automation.name}` : `Resume ${automation.name}`}
        checked={automation.enabled}
        disabled={flip.isPending}
        onChange={() => flip.mutate({ id: automation.id, enabled: !automation.enabled })}
      />
    </MenuLine>
  );
}

function ColumnLine({ column }: { column: BoardColumn }) {
  const flip = useRpcMutation("board.switchJob");
  const agent = column.job?.choice?.agent;
  return (
    <MenuLine
      mark={agent ? <HarnessLogo id={agent} size={16} /> : <Columns2 size={16} />}
      name={column.name}
      what={["When a card arrives", agent ? harnessShortName(agent) : null].filter(Boolean).join(" · ")}
    >
      <Switch
        aria-label={column.jobEnabled ? `Pause ${column.name}` : `Resume ${column.name}`}
        checked={column.jobEnabled}
        disabled={flip.isPending}
        onChange={() => flip.mutate({ columnId: column.id, enabled: !column.jobEnabled })}
      />
    </MenuLine>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="automations-menu-group" aria-label={label}>
      <h3 className="automations-menu-label">{label}</h3>
      <ul>{children}</ul>
    </section>
  );
}

/** The ready-made ones a board does not have yet. One for the board is added at once; a rule opens its form filled in. */
function ReadyMade({
  projectId,
  jobs,
  rules,
  onRule,
}: {
  projectId: string;
  jobs: readonly BoardColumn[];
  rules: readonly Automation[];
  onRule: (made: Extract<ReadyMadeAutomation, { kind: "rule" }>) => void;
}) {
  const add = useRpcMutation("board.addReadyMade");
  const has = (made: ReadyMadeAutomation) =>
    made.kind === "board" ? made.columns.every((column) => jobs.some((job) => job.name.toLowerCase() === column.name.toLowerCase())) : rules.some((rule) => rule.name === made.name);
  const offered = READY_MADE_AUTOMATIONS.filter((made) => made.kind !== "schedule" && !has(made));
  if (offered.length === 0) return null;
  return (
    <Group label="Ready-made">
      {offered.map((made) => (
        <MenuLine key={made.id} mark={made.kind === "rule" ? <TriggerMark trigger={made.trigger} /> : <AutomationMark size={16} />} name={made.name} what={made.what}>
          <Button size="sm" disabled={add.isPending} onClick={() => (made.kind === "rule" ? onRule(made) : add.mutate({ projectId, id: made.id }))}>
            Add
          </Button>
        </MenuLine>
      ))}
    </Group>
  );
}

/**
 * The automations of a project's board, or of one task, from a button in the top bar: each with its switch, and a way
 * to add one. On a board the ready-made ones it lacks are offered too. On a task, the ones kept to it come first, then
 * the board's that act on a task's pull request.
 */
export function AutomationsMenu({ projectId, task }: { projectId: string; task?: Pick<Task, "id"> }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const rules = (useRpc("automations.list", { projectId }).data ?? []).filter((automation) => !automation.proposed);
  const jobs = useRpc("board.jobs", { projectId }, { enabled: !task }).data ?? [];
  const columns = useRpc("board.columns", { projectId }).data ?? [];
  const own = task ? rules.filter((automation) => automation.taskId === task.id) : [];
  const shared = rules.filter((automation) => !automation.taskId && (!task || (automation.trigger.kind === "pull_request" && triggerHasTask(automation.trigger, null))));
  const count = own.length + shared.filter((automation) => automation.enabled).length;
  const edit = (next: Editing) => {
    setOpen(false);
    setEditing(next);
  };
  const line = (automation: Automation) => <RuleLine key={automation.id} automation={automation} columns={columns} onTask={Boolean(task)} onEdit={() => edit({ automation })} />;
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip label="Automations">
          <Popover.Trigger render={task ? <Button size="sm" aria-label={`Automations, ${count} on this task`} /> : <IconButton aria-label="Automations" />}>
            <AutomationMark size={16} />
            {task && count > 0 ? <span className="tabular">{count}</span> : null}
          </Popover.Trigger>
        </Tooltip>
        <Popover.Portal>
          <CoversPreview />
          <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-40">
            <Popover.Popup ref={floatingGround} className="floating-popover automations-menu" aria-label="Automations">
              {task ? (
                <>
                  <Group label="This task">
                    {own.map(line)}
                    <li>
                      <button type="button" className="automations-menu-add" onClick={() => edit({ automation: null, preset: { taskId: task.id } })}>
                        <Plus size={16} /> Add automation
                      </button>
                    </li>
                  </Group>
                  {shared.length > 0 ? <Group label="From the board">{shared.map(line)}</Group> : null}
                </>
              ) : (
                <>
                  {jobs.length + shared.length > 0 ? (
                    <Group label="On this board">
                      {jobs.map((column) => (
                        <ColumnLine key={column.id} column={column} />
                      ))}
                      {shared.map(line)}
                    </Group>
                  ) : null}
                  <ReadyMade projectId={projectId} jobs={jobs} rules={rules} onRule={(made) => edit({ automation: null, preset: { made } })} />
                  <button type="button" className="automations-menu-add automations-menu-new" onClick={() => edit({ automation: null })}>
                    <Plus size={16} /> New automation
                  </button>
                </>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {editing ? <AutomationDialog key={editing.automation?.id ?? "new"} automation={editing.automation} projectId={projectId} preset={editing.preset} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

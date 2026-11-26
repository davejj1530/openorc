import { everyWords, type AccountsProject } from "@openorc/client";
import { triggerHasTask, type Automation, type AutomationAction, type AutomationTrigger } from "@openorc/protocol";
import { useState } from "react";
import { AgentBrief } from "../AgentBrief";
import { CheckFields } from "./CheckFields";
import { ProgramFields, useWriterChoice, type WriterChoice } from "./ProgramFields";
import { Plus, X } from "../icons";
import { Button, Dialog, Field, IconButton, Input, Select, TextButton } from "../ui";
import {
  checkMinutes,
  draftComplete,
  draftOf,
  draftProblem,
  newDraft,
  placeOptions,
  placeValue,
  stepFor,
  stepOptions,
  triggerFor,
  triggerKey,
  triggerOptions,
  type PlaceOption,
  type RuleDraft,
  type RulePreset,
  type TriggerKey,
} from "../../lib/automation-draft";
import { useRpc, useRpcMutation } from "../../lib/client";
import { useSpaceProjects } from "../../lib/space-queries";
import "./automations.css";

const sentence = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

type TriggerProps = {
  trigger: AutomationTrigger;
  taskId: string | null;
  projectId: string;
  project: AccountsProject | undefined;
  writer: WriterChoice;
  enabled: boolean;
  onChange: (trigger: AutomationTrigger) => void;
};

/** A choice of what sets it off, as this one may offer it: one kept to a task waits for no new task, and only a check has the timer. */
const offered = (value: TriggerKey, trigger: AutomationTrigger, taskId: string | null) => !(value === "task_created" && taskId) && (value !== "check" || trigger.kind === "check");

/** What sets it off: the kind, then what that kind needs. One the person describes is a program an agent writes; a check has its timer. */
function TriggerFields({ trigger, taskId, projectId, project, writer, enabled, onChange }: TriggerProps) {
  return (
    <div className="automation-form-part">
      <div className="automation-form-line">
        <Select aria-label="What sets it off" value={triggerKey(trigger)} onChange={(event) => onChange(triggerFor(event.target.value as TriggerKey, trigger, taskId))}>
          {triggerOptions.map((option) => (
            <option key={option.value} value={option.value} hidden={!offered(option.value, trigger, taskId)}>
              {option.label}
            </option>
          ))}
        </Select>
        {trigger.kind === "pull_request" && !taskId ? (
          <Select aria-label="Which pull requests" value={trigger.scope} onChange={(event) => onChange({ ...trigger, scope: event.target.value as typeof trigger.scope })}>
            <option value="ours">From your threads</option>
            <option value="any">Any in the repository</option>
          </Select>
        ) : null}
        {trigger.kind === "check" ? (
          <Select aria-label="How often the check runs" value={trigger.everyMinutes} onChange={(event) => onChange({ ...trigger, everyMinutes: Number(event.target.value) })}>
            {[...new Set([...checkMinutes, trigger.everyMinutes])].map((minutes) => (
              <option key={minutes} value={minutes}>
                {sentence(everyWords(minutes))}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {trigger.kind === "check" ? <CheckFields trigger={trigger} projectId={projectId} onChange={onChange} /> : null}
      {trigger.kind === "program" ? <ProgramFields trigger={trigger} project={project} writer={writer} enabled={enabled} onChange={onChange} /> : null}
    </div>
  );
}

/** One step: what it does, and what that needs. An agent is told in words and reads them on a model; a task is put in a place on the board. */
function StepFields({
  step,
  places,
  project,
  hasTask,
  onChange,
  onRemove,
}: {
  step: AutomationAction;
  places: readonly PlaceOption[];
  project: AccountsProject | undefined;
  /** Whether there is a task when this step runs, which decides whose model an agent left without one takes. */
  hasTask: boolean;
  onChange: (step: AutomationAction) => void;
  onRemove: (() => void) | null;
}) {
  return (
    <div className="automation-step">
      <div className="automation-form-line">
        <Select aria-label="What the step does" value={step.kind} onChange={(event) => onChange(stepFor(event.target.value as AutomationAction["kind"], step))}>
          {stepOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {step.kind === "agent" ? null : (
          <>
            <span className="automation-form-word">{step.kind === "move" ? "to" : "in"}</span>
            <Select
              aria-label="Where the task goes"
              value={placeValue(step, places)}
              onChange={(event) => onChange({ ...step, ...places.find((option) => option.value === event.target.value)!.place })}
            >
              {places.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </>
        )}
        {onRemove ? (
          <IconButton size="sm" className="automation-step-remove" aria-label="Remove step" onClick={onRemove}>
            <X size={15} />
          </IconButton>
        ) : null}
      </div>
      {step.kind === "agent" ? (
        <AgentBrief
          words={step.prompt}
          onWords={(prompt) => onChange({ ...step, prompt })}
          choice={step.choice}
          onChoice={(choice) => onChange({ ...step, choice })}
          project={project}
          sameLabel={hasTask ? "The task's model" : "Your usual model"}
          placeholder="Tell the agent what to do. It is also told what happened."
          rows={3}
        />
      ) : null}
    </div>
  );
}

function submitLabel(pending: boolean, existing: boolean): string {
  if (pending) return "Saving…";
  return existing ? "Save" : "Create";
}

/** The projects an automation can be for: the ones with a folder on this computer, where it runs. */
function useLocalProjects() {
  return (useSpaceProjects(true).data ?? []).filter((project) => project.rootPath);
}
type LocalProject = ReturnType<typeof useLocalProjects>[number];

/** The name, with the project beside it while the project can still be chosen: a kept automation and one on a task have theirs. */
function NameAndProject({
  draft,
  projects,
  chooseProject,
  disabled,
  onChange,
}: {
  draft: RuleDraft;
  projects: readonly LocalProject[];
  chooseProject: boolean;
  disabled: boolean;
  onChange: (patch: Partial<RuleDraft>) => void;
}) {
  return (
    <div className="automation-form-top">
      <Field label="Name">
        <Input autoFocus value={draft.name} maxLength={80} disabled={disabled} placeholder="Fix failed checks" onChange={(event) => onChange({ name: event.target.value })} />
      </Field>
      {chooseProject ? (
        <Field label="Project">
          <Select aria-label="Automation project" value={draft.projectId} disabled={disabled} onChange={(event) => onChange({ projectId: event.target.value })}>
            {projects.some((project) => project.id === draft.projectId) ? null : <option value={draft.projectId}>Choose a project</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}

/** The steps in order, up to four, each removable while another is left. */
function Steps({ draft, project, onChange }: { draft: RuleDraft; project: AccountsProject | undefined; onChange: (actions: AutomationAction[]) => void }) {
  const columns = useRpc("board.columns", { projectId: draft.projectId }, { enabled: Boolean(draft.projectId) });
  const places = placeOptions(columns.data ?? []);
  const { actions } = draft;
  // A step has a task when the trigger brings one, or a step before it made one.
  const taskAt = (index: number) => triggerHasTask(draft.trigger, draft.taskId) || actions.slice(0, index).some((step) => step.kind === "task");
  return (
    <div className="automation-form-part">
      {actions.map((step, index) => (
        <StepFields
          key={index}
          step={step}
          places={places}
          project={project}
          hasTask={taskAt(index)}
          onChange={(next) => onChange(actions.map((each, place) => (place === index ? next : each)))}
          onRemove={actions.length > 1 ? () => onChange(actions.filter((_, place) => place !== index)) : null}
        />
      ))}
      {actions.length < 4 ? (
        <TextButton className="automation-form-add" onClick={() => onChange([...actions, { kind: "agent", prompt: "", choice: null }])}>
          <Plus size={15} /> Add a step
        </TextButton>
      ) : null}
    </div>
  );
}

/** "When", naming the task for an automation kept to one. */
function WhenLabel({ taskId }: { taskId: string | null }) {
  const task = useRpc("tasks.get", { id: taskId ?? "" }, { enabled: Boolean(taskId) });
  return (
    <h3 id="automation-when" className="automation-form-label">
      {taskId ? `When, on ${task.data?.title ?? "this task"}` : "When"}
    </h3>
  );
}

/**
 * An automation's form: its name, what sets it off and the steps it then does. A new one is for the project chosen in
 * it, or for the one task it was opened on; a kept one can also be deleted here.
 */
export function AutomationDialog({ automation, projectId, preset, onClose }: { automation: Automation | null; projectId: string; preset?: RulePreset | undefined; onClose: () => void }) {
  const [draft, setDraft] = useState<RuleDraft>(() => (automation ? draftOf(automation) : newDraft(projectId, preset)));
  const projects = useLocalProjects();
  const project = projects.find((each) => each.id === draft.projectId);
  const save = useRpcMutation("automations.save");
  const remove = useRpcMutation("automations.remove");
  const write = useRpcMutation("automations.writeTrigger");
  const writer = useWriterChoice();
  const pending = save.isPending || remove.isPending || write.isPending;
  const problem = draftProblem(draft) ?? write.error?.message ?? save.error?.message ?? remove.error?.message;
  const put = (patch: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const submit = async () => {
    let { trigger } = draft;
    // A new program is set to be written as its automation is created, which then keeps its folder.
    if (trigger.kind === "program" && !trigger.id) {
      if (!writer.choice) return;
      const { id } = await write.mutateAsync({ projectId: draft.projectId, what: trigger.what.trim(), choice: writer.choice });
      trigger = { ...trigger, id };
      put({ trigger });
    }
    save.mutate({ ...draft, trigger, name: draft.name.trim(), ...(automation ? { id: automation.id } : {}) }, { onSuccess: onClose });
  };
  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())} title={automation ? "Edit automation" : "New automation"} width={560}>
      <form
        className="automation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit().catch(() => undefined);
        }}
      >
        <NameAndProject draft={draft} projects={projects} chooseProject={!automation && !draft.taskId} disabled={pending} onChange={put} />
        <section aria-labelledby="automation-when">
          <WhenLabel taskId={draft.taskId} />
          <TriggerFields
            trigger={draft.trigger}
            taskId={draft.taskId}
            projectId={draft.projectId}
            project={project}
            writer={writer}
            enabled={automation?.enabled ?? false}
            onChange={(trigger) => put({ trigger })}
          />
        </section>
        <section aria-labelledby="automation-do">
          <h3 id="automation-do" className="automation-form-label">
            Do
          </h3>
          <Steps draft={draft} project={project} onChange={(actions) => put({ actions })} />
        </section>
        {problem ? (
          <p className="text-sm text-bad break-words" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="automation-form-foot">
          {automation ? (
            <TextButton className="automation-form-delete" disabled={pending} onClick={() => remove.mutate({ id: automation.id }, { onSuccess: onClose })}>
              Delete
            </TextButton>
          ) : null}
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !project || !draftComplete(draft) || Boolean(draftProblem(draft))}>
            {submitLabel(pending, Boolean(automation))}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

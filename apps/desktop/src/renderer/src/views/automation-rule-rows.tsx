import { actionWords, everyWords, relativeTime, stepsWords, triggerWords } from "@openorc/client";
import { harnessShortName, type Automation } from "@openorc/protocol";
import { useState } from "react";
import { TriggerMark } from "../components/automations/TriggerMark";
import { Trash2 } from "../components/icons";
import { Button, IconButton, StatusDot, Switch, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { openThread } from "../lib/router";
import "../components/automations/automations.css";

/**
 * An automation's row in the page's tile: what it waits for and does, when it last acted, and its switch. It opens its
 * form. What stopped it from looking, or switched it off, shows under it.
 */
export function AutomationRow({ automation, projectName, onEdit }: { automation: Automation; projectName?: string | undefined; onEdit: () => void }) {
  const flip = useRpcMutation("automations.switch");
  const remove = useRpcMutation("automations.remove");
  const columns = useRpc("board.columns", { projectId: automation.projectId }).data ?? [];
  const busy = flip.isPending || remove.isPending;
  const problem = flip.error?.message ?? remove.error?.message ?? automation.problem;
  return (
    <div data-automation={automation.id} className="schedule-row">
      <div className="schedule-row-line">
        <button type="button" onClick={onEdit} className="schedule-row-open">
          <span className="schedule-row-well" aria-hidden="true">
            <TriggerMark trigger={automation.trigger} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="schedule-row-name truncate">{automation.name}</span>
            <span className="schedule-when truncate">{[triggerWords(automation.trigger, Boolean(automation.taskId)), stepsWords(automation, columns), projectName].filter(Boolean).join(" · ")}</span>
          </span>
        </button>
        <div className="schedule-tools">
          <Tooltip label="Delete automation">
            <IconButton className="schedule-delete" disabled={busy} aria-label="Delete automation" onClick={() => remove.mutate({ id: automation.id })}>
              <Trash2 size={15} />
            </IconButton>
          </Tooltip>
        </div>
        <span className="schedule-row-last tabular text-ink-3">
          {automation.lastFiredAt ? (
            <>
              <StatusDot tone="ok" />
              Ran {relativeTime(automation.lastFiredAt)}
            </>
          ) : (
            "Not run yet"
          )}
        </span>
        <span className="schedule-row-move" />
        <Switch
          aria-label={automation.enabled ? `Pause ${automation.name}` : `Resume ${automation.name}`}
          checked={automation.enabled}
          disabled={busy}
          onChange={() => flip.mutate({ id: automation.id, enabled: !automation.enabled })}
        />
      </div>
      {problem ? (
        <p className="schedule-row-note text-bad" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** An automation an agent wrote, laid out to be read before it is turned on: what sets it off, what it then does, and who wrote it. */
function ProposedAutomation({ automation, projectName }: { automation: Automation; projectName?: string | undefined }) {
  const flip = useRpcMutation("automations.switch");
  const remove = useRpcMutation("automations.remove");
  const columns = useRpc("board.columns", { projectId: automation.projectId }).data ?? [];
  const [shown, setShown] = useState(false);
  const { trigger, madeBy } = automation;
  const busy = flip.isPending || remove.isPending;
  return (
    <article data-automation={automation.id} className="automation-proposed">
      <header className="automation-proposed-head">
        <span className="schedule-row-well" aria-hidden="true">
          <TriggerMark trigger={trigger} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <h3 className="schedule-row-name truncate">{automation.name}</h3>
          {projectName ? <span className="schedule-when truncate">{projectName}</span> : null}
        </span>
      </header>
      <dl className="automation-proposed-facts">
        <dt>When</dt>
        <dd>
          {trigger.kind === "check" ? trigger.what : triggerWords(trigger).replace(/^When /, "")}
          {trigger.kind === "check" ? <span className="text-ink-3"> Checked {everyWords(trigger.everyMinutes)}.</span> : null}
        </dd>
        <dt>Do</dt>
        <dd>
          {automation.actions.map((action, index) => (
            <p key={index}>
              {actionWords(action, columns)}
              {action.kind === "agent" ? <span className="text-ink-2">: {action.prompt}</span> : null}
            </p>
          ))}
        </dd>
        {madeBy ? (
          <>
            <dt>Made by</dt>
            <dd>
              {harnessShortName(madeBy.agent)}
              {madeBy.threadId ? (
                <>
                  , in{" "}
                  <button type="button" className="automation-proposed-thread" onClick={() => openThread(madeBy.threadId!)}>
                    {madeBy.threadTitle}
                  </button>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {shown && trigger.kind === "check" ? <pre className="automation-proposed-check">{trigger.command}</pre> : null}
      <div className="automation-proposed-foot">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => flip.mutate({ id: automation.id, enabled: true })}>
          Turn on
        </Button>
        {trigger.kind === "check" ? (
          <Button size="sm" aria-expanded={shown} onClick={() => setShown(!shown)}>
            {shown ? "Hide the check" : "See the check"}
          </Button>
        ) : null}
        <Button size="sm" className="ml-auto" disabled={busy} onClick={() => remove.mutate({ id: automation.id })}>
          Dismiss
        </Button>
      </div>
      {flip.error || remove.error ? (
        <p className="schedule-row-note text-bad" role="alert">
          {flip.error?.message ?? remove.error?.message}
        </p>
      ) : null}
    </article>
  );
}

/** The automations agents wrote that wait for the person, above the ones already theirs. Nothing shows while none waits. */
export function ProposedAutomations({ automations, projectName }: { automations: readonly Automation[]; projectName: (projectId: string) => string | undefined }) {
  if (automations.length === 0) return null;
  return (
    <section aria-labelledby="automation-proposed-heading" className="automation-proposed-list">
      <h2 id="automation-proposed-heading" className="automation-heading">
        Proposed <span className="tabular text-attention">{automations.length}</span>
      </h2>
      {automations.map((automation) => (
        <ProposedAutomation key={automation.id} automation={automation} projectName={projectName(automation.projectId)} />
      ))}
    </section>
  );
}

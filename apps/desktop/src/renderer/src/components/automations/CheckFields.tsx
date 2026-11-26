import type { AutomationTrigger, CheckTry } from "@openorc/protocol";
import { useState } from "react";
import { useRpcMutation } from "../../lib/client";
import { Button, Input, Textarea } from "../ui";

type CheckTrigger = Extract<AutomationTrigger, { kind: "check" }>;

const SHOWN = 3;

/** What the check found when it ran: nothing yet, what is already there and so sets nothing off, or why it did not run. */
function CheckOutcome({ outcome }: { outcome: CheckTry }) {
  if (outcome.state === "failed")
    return (
      <p className="automation-check-outcome text-bad" role="alert">
        {outcome.reason}
      </p>
    );
  const { found } = outcome;
  if (found.length === 0) return <p className="automation-check-outcome">It finds nothing right now.</p>;
  return (
    <div className="automation-check-outcome">
      <p>{found.length === 1 ? "It finds one thing now. It is already there, so only new ones set it off." : `It finds ${found.length} now. They are already there, so only new ones set it off.`}</p>
      <ul className="automation-check-found">
        {found.slice(0, SHOWN).map((words, index) => (
          <li key={index}>{words}</li>
        ))}
        {found.length > SHOWN ? <li className="text-ink-3">And {found.length - SHOWN} more</li> : null}
      </ul>
    </div>
  );
}

/**
 * A check on a timer, as an agent writing an automation in its thread writes one: what it looks for in plain words,
 * and its command, which can be changed and run once with Try it to see what it finds now.
 */
export function CheckFields({ trigger, projectId, onChange }: { trigger: CheckTrigger; projectId: string; onChange: (trigger: CheckTrigger) => void }) {
  const run = useRpcMutation("automations.tryCheck");
  const [outcome, setOutcome] = useState<CheckTry | null>(null);
  const tryCommand = () => run.mutate({ projectId, command: trigger.command.trim() }, { onSuccess: setOutcome, onError: (error) => setOutcome({ state: "failed", reason: error.message }) });
  return (
    <>
      <Input aria-label="What the check looks for" value={trigger.what} maxLength={200} onChange={(event) => onChange({ ...trigger, what: event.target.value })} />
      <Textarea
        className="automation-form-command"
        aria-label="The check's command"
        rows={3}
        spellCheck={false}
        value={trigger.command}
        maxLength={4000}
        onChange={(event) => onChange({ ...trigger, command: event.target.value })}
      />
      <div className="automation-check-command-foot">
        <p className="automation-form-hint">Runs in the project folder. Each new line it prints sets the automation off once.</p>
        <Button size="sm" disabled={run.isPending || !projectId || !trigger.command.trim()} onClick={tryCommand}>
          {run.isPending ? "Trying…" : "Try it"}
        </Button>
      </div>
      {outcome ? <CheckOutcome outcome={outcome} /> : null}
    </>
  );
}

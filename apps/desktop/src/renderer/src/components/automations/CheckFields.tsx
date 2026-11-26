import { everyWords, type AccountsProject } from "@openorc/client";
import { isHarnessId, type AutomationTrigger, type CheckTry, type ThreadChoice } from "@openorc/protocol";
import { useState } from "react";
import { useRpcMutation } from "../../lib/client";
import { useDefaultAgent } from "../../lib/default-harness";
import { useModelCatalog } from "../../lib/use-model-catalog";
import { AgentBrief } from "../AgentBrief";
import { defaultChoice } from "../ModelPicker";
import { Button, TextButton, Textarea } from "../ui";

type CheckTrigger = Extract<AutomationTrigger, { kind: "check" }>;
/** The last time the check ran: what it found, or why it did not run. */
type Outcome = CheckTry & { everyMinutes: number };

const SHOWN = 3;

/** The command's toggle: to hide it, to show the one written, or to write one by hand while there is none. */
function commandToggle(open: boolean, command: string): string {
  if (open) return "Hide the command";
  return command ? "Show the command" : "Write the command yourself";
}

/** The model that writes the check: the one picked here, else the default of the agent new work starts on. */
function useWriter(): { choice: ThreadChoice | null; choose: (choice: ThreadChoice | null) => void } {
  const [picked, choose] = useState<ThreadChoice | null>(null);
  const models = useModelCatalog();
  const agent = useDefaultAgent() ?? null;
  const fallback = models.data ? defaultChoice(models.data, agent) : null;
  const usual = fallback && isHarnessId(fallback.agent) ? { agent: fallback.agent, model: fallback.model, effort: fallback.effort } : null;
  return { choice: picked ?? usual, choose };
}

/** What the check found when it ran: nothing yet, what is already there and so sets nothing off, or why it did not run. */
function CheckOutcome({ outcome }: { outcome: Outcome }) {
  if (outcome.state === "failed")
    return (
      <p className="automation-check-outcome text-bad" role="alert">
        {outcome.reason}
      </p>
    );
  const { found } = outcome;
  if (found.length === 0) return <p className="automation-check-outcome">It finds nothing right now, and looks again {everyWords(outcome.everyMinutes)}.</p>;
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
 * A trigger the person describes: what to watch for, in words, and the model that writes a check from them. The check
 * is a command, which runs once as it is written so the person sees what it finds now; it can be read, changed and
 * tried again, or written by hand.
 */
export function CheckFields({ trigger, projectId, project, onChange }: { trigger: CheckTrigger; projectId: string; project: AccountsProject | undefined; onChange: (trigger: CheckTrigger) => void }) {
  const writer = useWriter();
  const write = useRpcMutation("automations.writeCheck");
  const run = useRpcMutation("automations.tryCheck");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const busy = write.isPending || run.isPending;
  const startWriting = () => {
    if (!writer.choice) return;
    setOutcome(null);
    write.mutate(
      { projectId, what: trigger.what.trim(), choice: writer.choice },
      {
        onSuccess: (written) => {
          if (written.state === "written") {
            onChange({ ...trigger, command: written.command, everyMinutes: written.everyMinutes });
            setOutcome({ state: "ran", found: written.found, everyMinutes: written.everyMinutes });
            return;
          }
          if (written.command) {
            onChange({ ...trigger, command: written.command });
            setCommandOpen(true);
          }
          setOutcome({ state: "failed", reason: written.reason, everyMinutes: trigger.everyMinutes });
        },
        onError: (error) => setOutcome({ state: "failed", reason: error.message, everyMinutes: trigger.everyMinutes }),
      },
    );
  };
  const tryCommand = () =>
    run.mutate(
      { projectId, command: trigger.command.trim() },
      {
        onSuccess: (tried) => setOutcome({ ...tried, everyMinutes: trigger.everyMinutes }),
        onError: (error) => setOutcome({ state: "failed", reason: error.message, everyMinutes: trigger.everyMinutes }),
      },
    );
  return (
    <>
      <AgentBrief
        words={trigger.what}
        onWords={(what) => onChange({ ...trigger, what })}
        choice={writer.choice}
        onChoice={writer.choose}
        project={project}
        label="What to watch for"
        maxLength={200}
        rows={2}
        showEffort={false}
        placeholder="Describe what to watch for, such as: an issue opens with the bug label"
        disabled={busy}
        action={
          <Button size="sm" disabled={busy || !projectId || !writer.choice || !trigger.what.trim()} onClick={startWriting}>
            {trigger.command ? "Write it again" : "Write the check"}
          </Button>
        }
      />
      {write.isPending ? (
        <p className="automation-check-outcome" role="status">
          Writing the check and trying it…
        </p>
      ) : null}
      {outcome && !write.isPending ? <CheckOutcome outcome={outcome} /> : null}
      <TextButton className="automation-check-toggle" aria-expanded={commandOpen} onClick={() => setCommandOpen(!commandOpen)}>
        {commandToggle(commandOpen, trigger.command)}
      </TextButton>
      {commandOpen ? (
        <div className="automation-check-command">
          <Textarea
            className="automation-form-command"
            aria-label="The check's command"
            rows={3}
            spellCheck={false}
            value={trigger.command}
            maxLength={4000}
            placeholder="A command that prints one line for each thing that happened"
            onChange={(event) => onChange({ ...trigger, command: event.target.value })}
          />
          <div className="automation-check-command-foot">
            <p className="automation-form-hint">Runs in the project folder. Each new line it prints sets the automation off once.</p>
            <Button size="sm" disabled={busy || !projectId || !trigger.command.trim()} onClick={tryCommand}>
              {run.isPending ? "Trying…" : "Try it"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

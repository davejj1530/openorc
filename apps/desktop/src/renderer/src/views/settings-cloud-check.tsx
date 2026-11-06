import type { CloudCheck, CloudCheckStep, CloudProvider } from "@openorc/protocol";
import { Button } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpcMutation } from "../lib/client";
import { SettingRow } from "./settings-shared";
import "./settings-cloud-check.css";

export const CHECK_STEP_LABELS: Record<CloudCheckStep, string> = {
  sandbox: "Start a sandbox",
  tools: "Find Node, Git and Claude Code",
  runner: "Run a process",
  relay: "Reach this Mac",
  signins: "Keep sign-ins outside the sandbox",
  sync: "Sync a change both ways",
  remove: "Delete the sandbox",
};

function seconds(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function CheckSteps({ check }: { check: CloudCheck }) {
  return (
    <ol className="cloud-check-steps" aria-label="Cloud check">
      {check.steps.map(({ step, state, ms, detail, error }) => (
        <li key={step} data-state={state}>
          {/* A step that does not apply here is no pass: an empty ring, its reason beside it. */}
          <StepMark state={state === "skipped" ? "pending" : state} />
          <span className="cloud-check-step">
            <span>{CHECK_STEP_LABELS[step]}</span>
            {detail ? <span className="cloud-check-detail">{detail}</span> : null}
            {error ? (
              <span role="alert" className="cloud-check-error">
                {error}
              </span>
            ) : null}
          </span>
          <span className="cloud-check-time">{state === "done" || state === "failed" ? seconds(ms) : ""}</span>
        </li>
      ))}
    </ol>
  );
}

const PLACES: Record<CloudProvider, string> = { vercel: "On Vercel", agent37: "On Agent37", local: "In a sandbox simulated on this Mac" };

/**
 * Tries everything a cloud thread needs, in a throwaway sandbox where new cloud threads run: `place`, null while they
 * have nowhere to run. A check that ran elsewhere, before the service changed, is not shown; one still running is.
 */
export function CloudCheckCard({ check, place }: { check: CloudCheck | null; place: CloudProvider | null }) {
  const start = useRpcMutation("cloud.check");
  const shown = check && (check.provider === place || check.passed === null) ? check : null;
  const running = shown?.passed === null;
  const where = shown?.provider ?? place;
  let label = shown ? "Run again" : "Run check";
  if (running) label = "Checking";
  return (
    <div className="settings-group">
      <SettingRow label="Cloud check" hint={where ? PLACES[where] : undefined}>
        <Button disabled={!place || running || start.isPending} onClick={() => start.mutate({})}>
          {label}
        </Button>
      </SettingRow>
      {shown ? <CheckSteps check={shown} /> : null}
      {start.error ? (
        <p role="alert" className="text-bad mt-2">
          {start.error.message}
        </p>
      ) : null}
    </div>
  );
}

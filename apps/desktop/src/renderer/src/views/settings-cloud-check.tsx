import type { CloudCheck, CloudCheckStep, CloudService, CloudStatus } from "@openorc/protocol";
import { Button } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpcMutation } from "../lib/client";
import { Section, SettingRow } from "./settings-shared";
import "./settings-cloud-check.css";

const stepLabels: Record<CloudCheckStep, string> = {
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
          <StepMark state={state} />
          <span className="cloud-check-step">
            <span>{stepLabels[step]}</span>
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

const PLACES: Record<CloudService | "local", string> = { vercel: "On Vercel", agent37: "On Agent37", local: "In a sandbox simulated on this Mac" };

/** The check runs where new cloud threads run: the service "Run on" names, else Vercel once it has a team, for older cores. */
function checkService(status: CloudStatus): CloudService | null {
  if (status.service !== undefined) return status.service;
  return status.vercel?.team && status.vercel.project ? "vercel" : null;
}

function verdict(check: CloudCheck | null): string | undefined {
  if (!check || check.passed === null) return undefined;
  return check.passed ? "Cloud threads can run here." : "A cloud thread would fail at the step marked below.";
}

/** Tries everything a cloud thread needs, in a throwaway sandbox where new cloud threads would run. */
export function CloudCheckSection({ status }: { status: CloudStatus }) {
  const start = useRpcMutation("cloud.check");
  const { check } = status;
  const running = check?.passed === null;
  const where = PLACES[checkService(status) ?? "local"];
  return (
    <Section title="Check" description={verdict(check)}>
      <SettingRow label="Cloud check" hint={where}>
        <Button disabled={running || start.isPending} onClick={() => start.mutate({})}>
          {running ? "Checking" : "Run check"}
        </Button>
      </SettingRow>
      {check ? <CheckSteps check={check} /> : null}
      {start.error ? (
        <p role="alert" className="text-bad mt-2">
          {start.error.message}
        </p>
      ) : null}
    </Section>
  );
}

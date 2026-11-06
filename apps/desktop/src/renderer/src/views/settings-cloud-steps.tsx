import { useId, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, X } from "../components/icons";
import type { CloudBrainStatus, CloudCheck, CloudProvider, CloudService, CloudSignIns, CloudStatus } from "@openorc/protocol";
import { CHECK_STEP_LABELS } from "./settings-cloud-check";
import { SERVICE_NAMES, placeWords } from "./settings-cloud-place";
import { signInTitle } from "./settings-cloud-sign-ins";
import { SectionLevel } from "./settings-shared";
import "./settings-cloud-steps.css";

/** What getting ready for the cloud takes, in order. The cloud brain is optional: cloud threads run without it. */
export const CLOUD_STEPS = ["service", "signins", "check", "brain"] as const;
export type CloudStepId = (typeof CLOUD_STEPS)[number];

/** Where one step stands, in a few words under its title, and why it cannot start yet when it cannot. */
export interface CloudStepView {
  state: "done" | "failed" | "running" | "todo";
  summary: string;
  locked?: true;
}

export type CloudSteps = Record<CloudStepId, CloudStepView>;

const TITLES: Record<CloudStepId, string> = {
  service: "Connect a cloud service",
  signins: "Sign in your agents",
  check: "Run the cloud check",
  brain: "Set up the cloud brain",
};

const FIRST = "Connect a cloud service first.";

/** Where a check runs, said after a verb: "Passed on Agent37". */
const WHERE: Record<CloudProvider, string> = { vercel: "on Vercel", agent37: "on Agent37", local: "in a sandbox simulated on this Mac" };

/** The service new cloud threads run on; an older core does not say, so Vercel's once it has a team there. */
export function serviceOf(status: CloudStatus): CloudService | null {
  if (status.service !== undefined) return status.service;
  return status.vercel?.team && status.vercel.project ? "vercel" : null;
}

function serviceStep(status: CloudStatus): CloudStepView {
  const { vercel, agent37 } = status;
  const service = serviceOf(status);
  if (!service) return { state: "todo", summary: vercel && !vercel.team ? "Choose a Vercel team." : "Vercel or Agent37. One is enough." };
  if (vercel?.team && agent37) return { state: "done", summary: `Vercel and Agent37 · new threads run on ${SERVICE_NAMES[service]}` };
  return { state: "done", summary: service === "vercel" && vercel?.team ? `Vercel · ${vercel.team.name}` : SERVICE_NAMES[service] };
}

/** Done once one agent can sign in there: a cloud thread runs with that agent. The cloud brain's own sign-ins are its step's. */
function signInsStep(signIns: CloudSignIns | undefined): CloudStepView {
  const rows = (signIns?.rows ?? []).filter((row) => row.kind === "claude" || row.kind === "codex" || row.kind === "opencode");
  const ready = rows.filter((row) => row.state === "ready");
  if (!ready.length) return { state: signIns?.bringing ? "running" : "todo", summary: "One agent is enough to start." };
  const left = rows.length - ready.length;
  return { state: "done", summary: `${ready.map(signInTitle).join(", ")} ready${left ? `, ${left} more can sign in` : ""}` };
}

/** Only a check of where new cloud threads run now counts; one from before a service changed is ignored. */
function checkStep(check: CloudCheck | null, place: CloudProvider | null): CloudStepView {
  if (!place) return { state: "todo", summary: FIRST, locked: true };
  const where = WHERE[place];
  if (!check || check.provider !== place) return { state: "todo", summary: `Not run ${where} yet.` };
  if (check.passed === null) return { state: "running", summary: `Checking ${where}` };
  if (check.passed) return { state: "done", summary: `Passed ${where}` };
  const failed = check.steps.find((step) => step.state === "failed");
  return { state: "failed", summary: failed ? `${CHECK_STEP_LABELS[failed.step]} failed ${where}.` : `Failed ${where}.` };
}

const BRAIN = "A copy of OpenOrc in the cloud, for your phone while this Mac sleeps.";

function brainStep(brain: CloudBrainStatus | undefined, service: CloudService | null): CloudStepView {
  if (!service) return { state: "todo", summary: FIRST, locked: true };
  switch (brain?.state) {
    case "ready":
      return { state: "done", summary: `Runs on ${placeWords(brain)}` };
    case "setting-up":
      return { state: "running", summary: `Setting up on ${placeWords(brain)}` };
    case "moving":
    case "removing":
      return { state: "running", summary: BRAIN };
    case "incomplete":
      return { state: "failed", summary: `Setting up on ${placeWords(brain)} did not finish.` };
    default:
      return { state: "todo", summary: BRAIN };
  }
}

/** Each step's state from what the core says: `place` is where a new cloud thread would run now, null with nowhere. */
export function cloudSteps(input: { status: CloudStatus; place: CloudProvider | null; signIns: CloudSignIns | undefined; brain: CloudBrainStatus | undefined }): CloudSteps {
  const { status, place, signIns, brain } = input;
  return {
    service: serviceStep(status),
    signins: signInsStep(signIns),
    check: checkStep(status.check, place),
    brain: brainStep(brain, serviceOf(status)),
  };
}

/** The first step a cloud thread still needs, which opens by itself; null once cloud threads can run. */
export function nextStep(steps: CloudSteps): CloudStepId | null {
  return CLOUD_STEPS.find((id) => id !== "brain" && steps[id].state !== "done") ?? null;
}

function Mark({ number, state }: { number: number; state: CloudStepView["state"] }) {
  return (
    <span className="cloud-step-mark" aria-hidden="true">
      {state === "done" ? <Check size={13} strokeWidth={2.25} /> : null}
      {state === "failed" ? <X size={13} strokeWidth={2.25} /> : null}
      {state === "running" ? <Loader2 size={14} className="tool-row-live" /> : null}
      {state === "todo" ? number : null}
    </span>
  );
}

/**
 * One step of the checklist: its mark, title and where it stands, which open or close its settings below. A step that
 * cannot start yet stays closed. `onWork` says the person is working in it, so it stays open once it is done.
 */
export function CloudStep({
  id,
  view,
  next,
  open,
  onToggle,
  onWork,
  children,
}: {
  id: CloudStepId;
  view: CloudStepView;
  next: boolean;
  open: boolean;
  onToggle: () => void;
  onWork: () => void;
  children: ReactNode;
}) {
  const body = useId();
  const shown = open && !view.locked;
  return (
    <section className="cloud-step" data-state={view.state} data-next={next || undefined} data-step={id}>
      <h2 className="cloud-step-head">
        <button type="button" aria-expanded={shown} aria-controls={body} disabled={view.locked} onClick={onToggle}>
          <Mark number={CLOUD_STEPS.indexOf(id) + 1} state={view.state} />
          <span className="cloud-step-text">
            <span className="cloud-step-title">
              {TITLES[id]}
              {id === "brain" ? <span className="cloud-step-tag">Optional</span> : null}
            </span>
            <span className="cloud-step-summary">{view.summary}</span>
          </span>
          {view.locked ? null : <ChevronDown size={16} className="cloud-step-chevron" aria-hidden="true" />}
        </button>
      </h2>
      <div id={body} className="cloud-step-body" hidden={!shown} onFocus={onWork}>
        <SectionLevel.Provider value={3}>{children}</SectionLevel.Provider>
      </div>
    </section>
  );
}

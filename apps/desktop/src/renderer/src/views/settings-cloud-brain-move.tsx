import { useState } from "react";
import { brainRegionFor, type BrainRegion, type CloudBrainMoveSetup, type CloudBrainMoveStep, type CloudBrainStatus, type CloudService, type RpcParams } from "@openorc/protocol";
import { Button, Dialog, Field, TextButton } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpc, useRpcMutation } from "../lib/client";
import { RegionSelect, SERVICE_NAMES, placeWords } from "./settings-cloud-place";
import { Failure } from "./settings-secret-field";
import { SettingRow, Status } from "./settings-shared";
import "./settings-cloud-check.css";

type Moving = Extract<CloudBrainStatus, { state: "moving" }>;
/** The Move mutation, held by the section so its refusal shows under the row. */
type Mutation = { mutate(params: RpcParams<"cloud.brain.move">): void; isPending: boolean };

const STEPS: CloudBrainMoveStep[] = ["home", "setting-up", "removing", "back"];
const SETUP: Record<CloudBrainMoveSetup, string> = { machine: "Installing it", start: "Starting it", "sign-ins": "Sending it the sign-ins", projects: "Copying projects" };

const other = (service: CloudService): CloudService => (service === "vercel" ? "agent37" : "vercel");

function stepLabel(step: CloudBrainMoveStep, to: CloudService): string {
  switch (step) {
    case "home":
      return "Bring threads to this Mac";
    case "setting-up":
      return `Set up on ${SERVICE_NAMES[to]}`;
    case "removing":
      return `Remove it from ${SERVICE_NAMES[other(to)]}`;
    case "back":
      return "Move threads back";
  }
}

function stepState(index: number, at: number, stopped: boolean): "done" | "running" | "failed" | "pending" {
  if (index < at) return "done";
  if (index > at) return "pending";
  return stopped ? "failed" : "running";
}

/** What moving does, said before it starts: where the threads go, the phones, and how long. */
function moveWords(to: CloudService, phones: number): string {
  const threads = `Its threads come to this Mac first, then go to a new brain on ${SERVICE_NAMES[to]}.`;
  return phones ? `${threads} Phones need pairing again, and it takes a few minutes.` : `${threads} It takes a few minutes.`;
}

const params = (to: CloudService, region: BrainRegion | null) => (to === "vercel" && region ? { to, region } : { to });

/**
 * Moving a ready brain to the other service, after a confirm that says what happens. A brain on Vercel lives in a
 * region, so moving there asks which.
 */
export function MoveBrain({ to, disabled, move }: { to: CloudService; disabled: boolean; move: Mutation }) {
  const [confirming, setConfirming] = useState(false);
  const [region, setRegion] = useState<BrainRegion>(() => brainRegionFor(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const phones = useRpc("cloud.brain.phones", {}, { enabled: confirming }).data?.length ?? 0;
  // The brain's own Codex login cannot go with it: a ChatGPT login is the old brain's alone.
  const codex = useRpc("cloud.brain.signIns", {}, { enabled: confirming }).data?.codex.mode ?? null;
  return (
    <>
      <TextButton tone="muted" disabled={disabled || move.isPending} onClick={() => setConfirming(true)}>
        Move to {SERVICE_NAMES[to]}
      </TextButton>
      <Dialog open={confirming} onOpenChange={setConfirming} title={`Move the cloud brain to ${SERVICE_NAMES[to]}?`}>
        <div className="space-y-3">
          <p className="text-ink-2">{moveWords(to, phones)}</p>
          {to === "vercel" ? (
            <Field label="Region">
              <RegionSelect label="Region" value={region} disabled={false} onChange={setRegion} />
            </Field>
          ) : null}
          {codex ? <p className="text-ink-3">Its Codex sign-in doesn't move. Sign in again after.</p> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                move.mutate(params(to, region));
              }}
            >
              Move
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Each step of a move with a mark, the threads moved so far, and why it stopped when it did. */
function MoveSteps({ brain }: { brain: Moving }) {
  const at = STEPS.indexOf(brain.step);
  return (
    <ol className="cloud-check-steps" aria-label="Moving the cloud brain">
      {STEPS.map((step, index) => {
        const state = stepState(index, at, brain.error !== null);
        const current = index === at;
        return (
          <li key={step} data-state={state}>
            <StepMark state={state} />
            <span className="cloud-check-step">
              <span>{stepLabel(step, brain.to.service)}</span>
              {current && brain.setup && !brain.error ? <span className="cloud-check-detail">{SETUP[brain.setup]}</span> : null}
              {current && brain.error ? (
                <span role="alert" className="cloud-check-error">
                  {brain.error}
                </span>
              ) : null}
            </span>
            <span className="cloud-check-time">{current && brain.threads?.of ? `${brain.threads.done} of ${brain.threads.of}` : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A move under way, step by step; one that stopped goes on from where it stopped. */
/** What calling a stopped move off does, by where it stopped: before the old brain went it stays; after, threads stay here. */
function cancelLabel(brain: Moving): string {
  if (brain.step === "back") return "Leave them on this Mac";
  return brain.step === "removing" ? `Stay on ${SERVICE_NAMES[other(brain.to.service)]}` : "Call it off";
}

export function MovingBrain({ brain }: { brain: Moving }) {
  const move = useRpcMutation("cloud.brain.move");
  const cancel = useRpcMutation("cloud.brain.move.cancel");
  const busy = move.isPending || cancel.isPending;
  return (
    <>
      <SettingRow label={`Moving to ${placeWords(brain.to)}`}>
        {brain.error ? (
          <>
            <Status>Stopped</Status>
            <TextButton tone="muted" disabled={busy} onClick={() => cancel.mutate({})}>
              {cancelLabel(brain)}
            </TextButton>
            <Button disabled={busy} onClick={() => move.mutate(params(brain.to.service, brain.to.region))}>
              Try again
            </Button>
          </>
        ) : null}
      </SettingRow>
      <MoveSteps brain={brain} />
      <Failure error={move.error ?? cancel.error} />
    </>
  );
}

/** What the last move left to say, kept until dismissed: why it did not happen, or which threads stayed here. */
export function MoveNote({ note }: { note: string | undefined }) {
  const dismiss = useRpcMutation("cloud.brain.move.dismiss");
  if (!note) return null;
  return (
    <div className="settings-field items-start">
      <p role="alert" className="text-bad min-w-0 flex-1">
        {note}
      </p>
      <TextButton tone="muted" className="shrink-0" disabled={dismiss.isPending} onClick={() => dismiss.mutate({})}>
        Dismiss
      </TextButton>
    </div>
  );
}

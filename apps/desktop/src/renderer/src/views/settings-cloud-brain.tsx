import { useState } from "react";
import { BRAIN_REGIONS, brainRegionFor, type BrainRegion, type CloudBrainMachine, type CloudBrainStatus, type CloudBrainStep } from "@openorc/protocol";
import { Button, Dialog, Select, TextButton, Tooltip } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpc, useRpcMutation } from "../lib/client";
import { CloudBrainProjects } from "./settings-cloud-brain-projects";
import { PairingCode, pairingSheet, useTicker } from "./settings-phone";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow, Status } from "./settings-shared";
import "./settings-cloud-check.css";

/** Vercel is asked on each look; the brain falls asleep on its own about five minutes after its last use. */
const REFRESH_MS = 30_000;

const regionName = (region: BrainRegion) => `${BRAIN_REGIONS[region]} · ${region}`;

/** Every region Vercel runs sandboxes in, by city: where the brain is set up, and where new sandboxes run. */
export function RegionSelect({ label, value, disabled, onChange }: { label?: string; value: BrainRegion; disabled: boolean; onChange: (region: BrainRegion) => void }) {
  return (
    <Select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as BrainRegion)}>
      {(Object.keys(BRAIN_REGIONS) as BrainRegion[]).map((option) => (
        <option key={option} value={option}>
          {regionName(option)}
        </option>
      ))}
    </Select>
  );
}

const stepLabels: Record<CloudBrainStep, string> = {
  machine: "Make its machine and install it",
  start: "Start it",
  "sign-ins": "Send it the Claude sign-ins",
};
const STEPS = Object.keys(stepLabels) as CloudBrainStep[];

const machineLabels: Record<CloudBrainMachine, string> = { awake: "Awake", asleep: "Asleep", starting: "Waking", stopping: "Going to sleep", failed: "Failed" };

/** What the brain's machine is doing, an update or a wake under way first; null while Vercel cannot be asked. */
function machineStatus(brain: Extract<CloudBrainStatus, { state: "ready" }>, waking: boolean): { label: string; ok: boolean } | null {
  if (brain.working === "updating") return { label: "Updating", ok: false };
  if (waking) return { label: "Waking", ok: false };
  return brain.machine && { label: machineLabels[brain.machine], ok: brain.machine === "awake" };
}

function Alert({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-bad mt-2">
      {error}
    </p>
  ) : null;
}

function NotSetUp({ available }: { available: boolean }) {
  const create = useRpcMutation("cloud.brain.create");
  const [region, setRegion] = useState<BrainRegion>(() => brainRegionFor(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const setUp = (
    <Button disabled={!available || create.isPending} onClick={() => create.mutate({ region })}>
      Set up
    </Button>
  );
  return (
    <>
      <SettingRow label="Region" hint="Fixed once it is set up.">
        <RegionSelect label="Region" value={region} disabled={!available || create.isPending} onChange={setRegion} />
        {available ? setUp : <Tooltip label="The cloud brain isn't available in this build.">{setUp}</Tooltip>}
      </SettingRow>
      <Failure error={create.error} />
    </>
  );
}

function stepState(index: number, at: number): "done" | "running" | "pending" {
  if (index < at) return "done";
  return index === at ? "running" : "pending";
}

function SettingUp({ region, step }: { region: BrainRegion; step: CloudBrainStep }) {
  const at = STEPS.indexOf(step);
  return (
    <>
      <SettingRow label={regionName(region)}>
        <Status>Setting up</Status>
      </SettingRow>
      <ol className="cloud-check-steps" aria-label="Setting up the cloud brain">
        {STEPS.map((each, index) => {
          const state = stepState(index, at);
          return (
            <li key={each} data-state={state}>
              <StepMark state={state} />
              <span className="cloud-check-step">{stepLabels[each]}</span>
              <span />
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Deletes the brain from the team, after a confirm. */
function RemoveBrain({ disabled }: { disabled: boolean }) {
  const remove = useRpcMutation("cloud.brain.remove");
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <TextButton tone="muted" disabled={disabled || remove.isPending} onClick={() => setConfirming(true)}>
        Remove
      </TextButton>
      <Dialog open={confirming} onOpenChange={setConfirming} title="Remove the cloud brain?">
        <div className="space-y-3">
          <p className="text-ink-2">This deletes it from your Vercel team, with its disk and the sandboxes it made. Phones paired with it can no longer reach it.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                remove.mutate({});
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** The pairing code the brain makes, in the sheet the Phone page shows its own in. */
function PairBrainPhone({ disabled }: { disabled: boolean }) {
  const pair = useRpcMutation("cloud.brain.pair");
  const [open, setOpen] = useState(false);
  const sheet = pairingSheet({ offer: pair.data, error: pair.error, seen: false, listed: false, now: Date.now() });
  useTicker(open && sheet.kind === "live");
  const start = () => {
    setOpen(true);
    pair.mutate({});
  };
  return (
    <>
      <Button disabled={disabled} onClick={start}>
        Pair phone
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Pair a phone" width={360}>
        <PairingCode sheet={sheet} retry={start} />
      </Dialog>
    </>
  );
}

function Ready({ brain, active }: { brain: Extract<CloudBrainStatus, { state: "ready" }>; active: boolean }) {
  const wake = useRpcMutation("cloud.brain.wake");
  const handover = useRpcMutation("cloud.brain.handover");
  const busy = brain.working !== null || wake.isPending || handover.isPending;
  const machine = machineStatus(brain, brain.working === "waking" || wake.isPending);
  return (
    <>
      <SettingRow label={regionName(brain.region)}>
        {machine ? <Status ok={machine.ok}>{machine.label}</Status> : null}
        {brain.machine === "asleep" && !busy ? (
          <TextButton tone="muted" onClick={() => wake.mutate({})}>
            Wake
          </TextButton>
        ) : null}
        <PairBrainPhone disabled={busy} />
        <RemoveBrain disabled={busy} />
      </SettingRow>
      <SettingRow label="Claude accounts" hint={brain.claude.length ? brain.claude.join(", ") : "None"}>
        {brain.working === "sending" || handover.isPending ? <Status>Sending</Status> : null}
        {brain.behind && !busy ? (
          <TextButton tone="muted" onClick={() => handover.mutate({})}>
            Send
          </TextButton>
        ) : null}
      </SettingRow>
      <CloudBrainProjects active={active} />
      <Alert error={brain.error} />
    </>
  );
}

function BrainState({ brain, active }: { brain: CloudBrainStatus; active: boolean }) {
  const create = useRpcMutation("cloud.brain.create");
  switch (brain.state) {
    case "unavailable":
      return <NotSetUp available={false} />;
    case "none":
      return (
        <>
          <NotSetUp available />
          <Alert error={brain.error} />
        </>
      );
    case "elsewhere":
      return (
        <>
          <SettingRow label="Already in this team" hint="This Mac doesn't have its key.">
            <RemoveBrain disabled={false} />
          </SettingRow>
          <Alert error={brain.error} />
        </>
      );
    case "setting-up":
      return <SettingUp region={brain.region} step={brain.step} />;
    case "incomplete":
      return (
        <>
          <SettingRow label={regionName(brain.region)}>
            <Status>Not set up</Status>
            <Button disabled={create.isPending} onClick={() => create.mutate({ region: brain.region })}>
              Try again
            </Button>
            <RemoveBrain disabled={create.isPending} />
          </SettingRow>
          <Alert error={brain.error} />
          <Failure error={create.error} />
        </>
      );
    case "ready":
      return <Ready brain={brain} active={active} />;
    case "removing":
      return (
        <SettingRow label="Cloud brain">
          <Status>Removing</Status>
        </SettingRow>
      );
  }
}

/** OpenOrc in the user's own Vercel team: set up from here, handed this Mac's Claude sign-ins and projects, paired with a phone. */
export function CloudBrainSection({ active }: { active: boolean }) {
  const status = useRpc("cloud.brain.status", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  return (
    <Section title="Cloud brain" description="A copy of OpenOrc in your Vercel team, for your phone while this Mac sleeps.">
      {status.data ? <BrainState brain={status.data} active={active} /> : null}
      <Failure error={status.error} />
    </Section>
  );
}

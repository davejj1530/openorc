import { useState } from "react";
import {
  BRAIN_REGIONS,
  brainRegionFor,
  type BrainRegion,
  type CloudBrainDoor,
  type CloudBrainMachine,
  type CloudBrainPlace,
  type CloudBrainStatus,
  type CloudBrainStep,
  type CloudService,
} from "@openorc/protocol";
import { Button, Dialog, Select, TextButton, Tooltip } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpc, useRpcMutation } from "../lib/client";
import { CloudBrainPhones } from "./settings-cloud-brain-phones";
import { CloudBrainProjects } from "./settings-cloud-brain-projects";
import { CloudBrainSignIns } from "./settings-cloud-brain-signins";
import { BringMissing } from "./settings-cloud-sign-ins";
import { PairingCode, pairingSheet, useTicker } from "./settings-phone";
import { Failure, StillWorks } from "./settings-secret-field";
import { Section, SettingRow, Status } from "./settings-shared";
import "./settings-cloud-check.css";

/** Its service is asked on each look; the brain falls asleep on its own about five minutes after its last use. */
const REFRESH_MS = 30_000;

const regionName = (region: BrainRegion) => `${BRAIN_REGIONS[region]} · ${region}`;

/** How each service's words go: where the brain lives, what it makes there, and how its cost is counted. */
const SERVICES: Record<CloudService, { name: string; account: string; machines: string; cost: string }> = {
  vercel: {
    name: "Vercel",
    account: "your Vercel team",
    machines: "sandboxes",
    cost: "Vercel's list prices for the brain, its thread sandboxes and their snapshots, before your plan's credit.",
  },
  agent37: { name: "Agent37", account: "your Agent37 account", machines: "instances", cost: "What Agent37 counts for the brain and the thread instances it made." },
};

/** A brain on Vercel by its region; one on Agent37, which has a single region, by its service. */
const placeName = ({ service, region }: CloudBrainPlace) => (region ? regionName(region) : SERVICES[service].name);

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
  "sign-ins": "Send it the sign-ins",
};
const STEPS = Object.keys(stepLabels) as CloudBrainStep[];

const machineLabels: Record<CloudBrainMachine, string> = { awake: "Awake", asleep: "Asleep", starting: "Waking", stopping: "Going to sleep", failed: "Failed" };
const doorLabels: Record<CloudBrainDoor["state"], string> = { open: "Open", opening: "Opening", failed: "Not open" };

/** What the brain's machine is doing, an update or a wake under way first; null while its service cannot be asked. */
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

/** The door a phone knocks on to wake the brain: a state in a word, and why when it could not open. */
function Door({ door }: { door: CloudBrainDoor | null }) {
  if (!door) return null;
  return (
    <>
      <SettingRow label="Door">
        <Status ok={door.state === "open"}>{doorLabels[door.state]}</Status>
      </SettingRow>
      <Alert error={door.state === "failed" ? door.error : null} />
    </>
  );
}

/** Before its first wake, the brain's setup offers the step that brings every sign-in, so it wakes with them. */
function SignInsFirst() {
  const signIns = useRpc("cloud.signIns", {}).data;
  return signIns ? <BringMissing signIns={signIns} label="Sign-ins for the cloud" /> : null;
}

/** Set up on the service new cloud threads run on; on Vercel in a region, since Agent37 has one. */
function NotSetUp({ available, service }: { available: boolean; service: CloudService }) {
  const create = useRpcMutation("cloud.brain.create");
  const [region, setRegion] = useState<BrainRegion>(() => brainRegionFor(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const vercel = service === "vercel";
  const setUp = (
    <Button disabled={!available || create.isPending} onClick={() => create.mutate(vercel ? { region } : {})}>
      Set up
    </Button>
  );
  return (
    <>
      {available ? <SignInsFirst /> : null}
      <SettingRow label={vercel ? "Region" : SERVICES[service].name} hint={vercel ? "Fixed once it is set up." : null}>
        {vercel ? <RegionSelect label="Region" value={region} disabled={!available || create.isPending} onChange={setRegion} /> : null}
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

function SettingUp({ place, step }: { place: CloudBrainPlace; step: CloudBrainStep }) {
  const at = STEPS.indexOf(step);
  return (
    <>
      <SettingRow label={placeName(place)}>
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

/** What a removal deletes, the conversations on the brain by count when it has any. */
function removalWords(threads: number, service: CloudService): string {
  const { account, machines } = SERVICES[service];
  if (!threads) return `This deletes it from ${account}, with its disk and the ${machines} it made. Phones paired with it can no longer reach it.`;
  const conversations = threads === 1 ? "the conversation on it. Bring it to your Mac first to keep it." : `the ${threads} conversations on it. Bring to Mac any you want to keep first.`;
  return `This deletes it from ${account}, with its disk, the ${machines} it made and ${conversations} Phones paired with it can no longer reach it.`;
}

/** Deletes the brain from its service, after a confirm that counts the conversations going with it. */
function RemoveBrain({ disabled, service, threads = 0 }: { disabled: boolean; service: CloudService; threads?: number }) {
  const remove = useRpcMutation("cloud.brain.remove");
  const recount = useRpcMutation("cloud.brain.recount");
  const [confirming, setConfirming] = useState(false);
  // The brain's own Codex login goes with it, and keeps working at OpenAI.
  const codex = useRpc("cloud.brain.signIns", {}, { enabled: confirming }).data?.codex.mode ?? null;
  const confirm = () => {
    setConfirming(true);
    recount.mutate({});
  };
  return (
    <>
      <TextButton tone="muted" disabled={disabled || remove.isPending} onClick={confirm}>
        Remove
      </TextButton>
      <Dialog open={confirming} onOpenChange={setConfirming} title="Remove the cloud brain?">
        <div className="space-y-3">
          <p className="text-ink-2">{removalWords(threads, service)}</p>
          <StillWorks at={codex} subject={codex === "apiKey" ? "Its OpenAI API key " : "Its Codex login "} />
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

/** What the brain and its thread machines ran this month, quietly; how it is counted on demand. Never wakes the brain. */
function BrainCost({ active, service }: { active: boolean; service: CloudService }) {
  const cost = useRpc("cloud.brain.cost", {}, { enabled: active, staleTime: 5 * 60_000 }).data;
  if (!cost) return null;
  return (
    <SettingRow label="This month">
      <Tooltip label={SERVICES[service].cost}>
        <span className="text-ink-3">{cost.usd < 0.01 ? "Less than $0.01" : `$${cost.usd.toFixed(2)}`}</span>
      </Tooltip>
    </SettingRow>
  );
}

function Ready({ brain, active }: { brain: Extract<CloudBrainStatus, { state: "ready" }>; active: boolean }) {
  const wake = useRpcMutation("cloud.brain.wake");
  const handover = useRpcMutation("cloud.brain.handover");
  const busy = brain.working !== null || wake.isPending || handover.isPending;
  const machine = machineStatus(brain, brain.working === "waking" || wake.isPending);
  return (
    <>
      <SettingRow label={placeName(brain)}>
        {machine ? <Status ok={machine.ok}>{machine.label}</Status> : null}
        {brain.machine === "asleep" && !busy ? (
          <TextButton tone="muted" onClick={() => wake.mutate({})}>
            Wake
          </TextButton>
        ) : null}
        <PairBrainPhone disabled={busy} />
        <RemoveBrain disabled={busy} service={brain.service} threads={brain.threads} />
      </SettingRow>
      <CloudBrainPhones active={active} busy={busy} />
      <SettingRow label="Claude accounts" hint={brain.claude.length ? brain.claude.join(", ") : "None"}>
        {brain.working === "sending" || handover.isPending ? <Status>Sending</Status> : null}
        {brain.behind && !busy ? (
          <TextButton tone="muted" onClick={() => handover.mutate({})}>
            Send
          </TextButton>
        ) : null}
      </SettingRow>
      <CloudBrainSignIns active={active} busy={busy} />
      <Door door={brain.door} />
      <CloudBrainProjects active={active} />
      <BrainCost active={active} service={brain.service} />
      <Alert error={brain.error} />
    </>
  );
}

function BrainState({ brain, active, service }: { brain: CloudBrainStatus; active: boolean; service: CloudService }) {
  const create = useRpcMutation("cloud.brain.create");
  switch (brain.state) {
    case "unavailable":
      return <NotSetUp available={false} service={service} />;
    case "none":
      return (
        <>
          <NotSetUp available service={service} />
          <Alert error={brain.error} />
        </>
      );
    case "elsewhere":
      return (
        <>
          <SettingRow label={brain.service === "vercel" ? "Already in this team" : "Already on this account"} hint="This Mac doesn't have its key.">
            <RemoveBrain disabled={false} service={brain.service} />
          </SettingRow>
          <Alert error={brain.error} />
        </>
      );
    case "setting-up":
      return <SettingUp place={brain} step={brain.step} />;
    case "incomplete":
      return (
        <>
          <SettingRow label={placeName(brain)}>
            <Status>Not set up</Status>
            <Button disabled={create.isPending} onClick={() => create.mutate(brain.region ? { region: brain.region } : {})}>
              Try again
            </Button>
            <RemoveBrain disabled={create.isPending} service={brain.service} />
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

/**
 * OpenOrc on the user's own Vercel team or Agent37 account: set up from here, handed this Mac's Claude sign-ins and
 * projects, paired with a phone. `service` is where new cloud threads run, and so where a brain set up now goes.
 */
export function CloudBrainSection({ active, service }: { active: boolean; service: CloudService }) {
  const status = useRpc("cloud.brain.status", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const brain = status.data;
  const where = brain && "service" in brain ? brain.service : service;
  return (
    <Section title="Cloud brain" description={`A copy of OpenOrc in ${SERVICES[where].account}, for your phone while this Mac sleeps.`}>
      {brain ? <BrainState brain={brain} active={active} service={service} /> : null}
      <Failure error={status.error} />
    </Section>
  );
}

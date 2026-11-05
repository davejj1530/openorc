import { useState, type ComponentProps } from "react";
import { brainRegionFor, type BrainRegion, type CloudBrainDoor, type CloudBrainMachine, type CloudBrainPlace, type CloudBrainStatus, type CloudBrainStep, type CloudService } from "@openorc/protocol";
import { Button, Dialog, Segmented, TextButton, Tooltip } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpc, useRpcMutation } from "../lib/client";
import { MoveBrain, MoveNote, MovingBrain } from "./settings-cloud-brain-move";
import { CloudBrainPhones } from "./settings-cloud-brain-phones";
import { CloudBrainProjects } from "./settings-cloud-brain-projects";
import { CloudBrainSignIns } from "./settings-cloud-brain-signins";
import { BringMissing } from "./settings-cloud-sign-ins";
import { PairingCode, pairingSheet, useTicker } from "./settings-phone";
import { RegionSelect, SERVICE_NAMES, placeWords } from "./settings-cloud-place";
import { Failure, StillWorks } from "./settings-secret-field";
import { Section, SettingRow, Status } from "./settings-shared";
import "./settings-cloud-check.css";

/** Its service is asked on each look; the brain falls asleep on its own about five minutes after its last use. */
const REFRESH_MS = 30_000;

/** How each service's words go: where the brain lives, what it makes there, and how its cost is counted. */
const SERVICES: Record<CloudService, { account: string; machines: string; cost: string }> = {
  vercel: {
    account: "your Vercel team",
    machines: "sandboxes",
    cost: "Vercel's list prices for the brain, its thread sandboxes and their snapshots, before your plan's credit.",
  },
  agent37: { account: "your Agent37 account", machines: "instances", cost: "What Agent37 counts for the brain and the thread instances it made." },
};

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

/**
 * Set up where it runs: with both services connected, a choice starting on the one new cloud threads run on; with one,
 * there. On Vercel in a region, since Agent37 has one. Set up ends the last row either way.
 */
function NotSetUp({ available, place }: { available: boolean; place: Place }) {
  const create = useRpcMutation("cloud.brain.create");
  const [region, setRegion] = useState<BrainRegion>(() => brainRegionFor(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const { service, services, choose } = place;
  const vercel = service === "vercel";
  const choosing = services.length > 1;
  const busy = !available || create.isPending;
  const button = (
    <Button disabled={busy} onClick={() => create.mutate({ ...(vercel ? { region } : {}), ...(choosing ? { service } : {}) })}>
      Set up
    </Button>
  );
  const setUp = available ? button : <Tooltip label="The cloud brain isn't available in this build.">{button}</Tooltip>;
  return (
    <>
      {available ? <SignInsFirst /> : null}
      {choosing ? (
        <SettingRow label="Runs on">
          <Segmented label="Runs on" value={service} onChange={choose} options={services.map((each) => ({ value: each, label: SERVICE_NAMES[each] }))} />
          {vercel ? null : setUp}
        </SettingRow>
      ) : null}
      {vercel ? (
        <SettingRow label="Region" hint="Fixed once it is set up.">
          <RegionSelect label="Region" value={region} disabled={busy} onChange={setRegion} />
          {setUp}
        </SettingRow>
      ) : null}
      {vercel || choosing ? null : <SettingRow label={SERVICE_NAMES[service]}>{setUp}</SettingRow>}
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
      <SettingRow label={placeWords(place)}>
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

/** Pairing, unless a row of its own asks to pair again after a move; moving, once the other service is connected; removing. */
function BrainActions({
  brain,
  busy,
  to,
  move,
}: {
  brain: Extract<CloudBrainStatus, { state: "ready" }>;
  busy: boolean;
  to: CloudService | undefined;
  move: ComponentProps<typeof MoveBrain>["move"];
}) {
  return (
    <>
      {brain.pairAgain ? null : <PairBrainPhone disabled={busy} />}
      {to ? <MoveBrain to={to} disabled={busy} move={move} /> : null}
      <RemoveBrain disabled={busy} service={brain.service} threads={brain.threads} />
    </>
  );
}

function Ready({ brain, active, services }: { brain: Extract<CloudBrainStatus, { state: "ready" }>; active: boolean; services: CloudService[] }) {
  const wake = useRpcMutation("cloud.brain.wake");
  const handover = useRpcMutation("cloud.brain.handover");
  const move = useRpcMutation("cloud.brain.move");
  const busy = brain.working !== null || wake.isPending || handover.isPending || move.isPending;
  const machine = machineStatus(brain, brain.working === "waking" || wake.isPending);
  // A move goes to the other service, once it is connected.
  const to = services.find((service) => service !== brain.service);
  return (
    <>
      <SettingRow label={`Runs on ${placeWords(brain)}`}>
        {machine ? <Status ok={machine.ok}>{machine.label}</Status> : null}
        {brain.machine === "asleep" && !busy ? (
          <TextButton tone="muted" onClick={() => wake.mutate({})}>
            Wake
          </TextButton>
        ) : null}
        <BrainActions brain={brain} busy={busy} to={to} move={move} />
      </SettingRow>
      <Failure error={move.error} />
      <MoveNote note={brain.note} />
      {brain.pairAgain ? (
        <SettingRow label="Pair your phone again" hint="Phones paired before the move can't reach it.">
          <PairBrainPhone disabled={busy} />
        </SettingRow>
      ) : null}
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

/** Where a brain set up now runs: the service chosen, among those connected. */
interface Place {
  service: CloudService;
  services: CloudService[];
  choose: (service: CloudService) => void;
}

function BrainState({ brain, active, place }: { brain: CloudBrainStatus; active: boolean; place: Place }) {
  const create = useRpcMutation("cloud.brain.create");
  switch (brain.state) {
    case "unavailable":
      return <NotSetUp available={false} place={place} />;
    case "none":
      return (
        <>
          <NotSetUp available place={place} />
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
          <SettingRow label={placeWords(brain)}>
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
      return <Ready brain={brain} active={active} services={place.services} />;
    case "moving":
      return <MovingBrain brain={brain} />;
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
 * projects, paired with a phone, moved between the two. `service` is where new cloud threads run, and so where a brain
 * set up now goes unless another of the connected `services` is chosen.
 */
export function CloudBrainSection({ active, service, services = [service] }: { active: boolean; service: CloudService; services?: CloudService[] }) {
  const status = useRpc("cloud.brain.status", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const [chosen, choose] = useState<CloudService | null>(null);
  const brain = status.data;
  const place = { service: chosen && services.includes(chosen) ? chosen : service, services, choose };
  const where = brain && "service" in brain ? brain.service : place.service;
  return (
    <Section title="Cloud brain" description={`A copy of OpenOrc in ${SERVICES[where].account}, for your phone while this Mac sleeps.`}>
      {brain ? <BrainState brain={brain} active={active} place={place} /> : null}
      <Failure error={status.error} />
    </Section>
  );
}

import { useState } from "react";
import { brainRegionFor, type BrainRegion, type CloudBrainDoor, type CloudBrainMachine, type CloudBrainPlace, type CloudBrainStatus, type CloudBrainStep, type CloudService } from "@openorc/protocol";
import { Button, Dialog, Segmented, TextButton, Tooltip } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { useRpc, useRpcMutation } from "../lib/client";
import { MoveBrain, MoveNote, MovingBrain } from "./settings-cloud-brain-move";
import { CloudBrainPhones } from "./settings-cloud-brain-phones";
import { CloudBrainProjects } from "./settings-cloud-brain-projects";
import { CloudBrainSignIns } from "./settings-cloud-brain-signins";
import { BringMissing } from "./settings-cloud-sign-ins";
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

/** What the brain and its thread machines ran this month, quietly; how it is counted on demand. Never wakes the brain. */
function BrainCost({ active, service }: { active: boolean; service: CloudService }) {
  const cost = useRpc("cloud.brain.cost", {}, { enabled: active, staleTime: 5 * 60_000 }).data;
  if (!cost) return null;
  return (
    <Tooltip label={SERVICES[service].cost}>
      <span>{cost.usd < 0.01 ? "Less than $0.01 this month" : `$${cost.usd.toFixed(2)} this month`}</span>
    </Tooltip>
  );
}

/** Its place and state first, with what it cost and what can be done to it, and why the last thing done to it failed. */
function BrainCard({ brain, active, services, busy, waking }: { brain: Ready; active: boolean; services: CloudService[]; busy: boolean; waking: boolean }) {
  const wake = useRpcMutation("cloud.brain.wake");
  const move = useRpcMutation("cloud.brain.move");
  const machine = machineStatus(brain, waking || wake.isPending);
  const working = busy || wake.isPending || move.isPending;
  // A move goes to the other service, once it is connected.
  const to = services.find((service) => service !== brain.service);
  return (
    <div className="settings-group cloud-step-lead">
      <SettingRow label={placeWords(brain)} hint={<BrainCost active={active} service={brain.service} />}>
        {machine ? <Status ok={machine.ok}>{machine.label}</Status> : null}
        {brain.machine === "asleep" && !working ? (
          <TextButton tone="muted" onClick={() => wake.mutate({})}>
            Wake
          </TextButton>
        ) : null}
        {to ? <MoveBrain to={to} disabled={working} move={move} /> : null}
        <RemoveBrain disabled={working} service={brain.service} threads={brain.threads} />
      </SettingRow>
      {brain.error ? (
        <div className="settings-field">
          <p role="alert" className="text-bad min-w-0 flex-1">
            {brain.error}
          </p>
          {working ? null : (
            <TextButton tone="muted" onClick={() => wake.mutate({})}>
              Try again
            </TextButton>
          )}
        </div>
      ) : null}
      <Failure error={move.error} />
      <MoveNote note={brain.note} />
      <Door door={brain.door} />
    </div>
  );
}

type Ready = Extract<CloudBrainStatus, { state: "ready" }>;

/** What the brain signs in with: the Claude accounts handed to it, Codex, GitHub and the keys it keeps a copy of. */
function BrainSignIns({ brain, active, busy }: { brain: Ready; active: boolean; busy: boolean }) {
  const handover = useRpcMutation("cloud.brain.handover");
  return (
    <Section title="Sign-ins">
      <SettingRow label="Claude accounts" hint={brain.claude.length ? brain.claude.join(", ") : "None"}>
        {brain.working === "sending" || handover.isPending ? <Status>Sending</Status> : null}
        {brain.behind && !busy && !handover.isPending ? (
          <TextButton tone="muted" onClick={() => handover.mutate({})}>
            Send
          </TextButton>
        ) : null}
      </SettingRow>
      <CloudBrainSignIns active={active} busy={busy} />
    </Section>
  );
}

/** A brain set up: its own card, then the phones that reach it, what it signs in with, and the projects it works in. */
function ReadyBrain({ brain, active, services }: { brain: Ready; active: boolean; services: CloudService[] }) {
  const busy = brain.working !== null;
  return (
    <>
      <BrainCard brain={brain} active={active} services={services} busy={busy} waking={brain.working === "waking"} />
      <CloudBrainPhones active={active} busy={busy} again={Boolean(brain.pairAgain)} />
      <BrainSignIns brain={brain} active={active} busy={busy} />
      <CloudBrainProjects active={active} />
    </>
  );
}

/** Where a brain set up now runs: the service chosen, among those connected. */
interface Place {
  service: CloudService;
  services: CloudService[];
  choose: (service: CloudService) => void;
}

/** Every state but a brain set up, which has cards of its own. */
function BrainState({ brain, place }: { brain: Exclude<CloudBrainStatus, Ready>; place: Place }) {
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
export function CloudBrain({ active, service, services = [service] }: { active: boolean; service: CloudService; services?: CloudService[] }) {
  const status = useRpc("cloud.brain.status", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const [chosen, choose] = useState<CloudService | null>(null);
  const brain = status.data;
  const place = { service: chosen && services.includes(chosen) ? chosen : service, services, choose };
  if (brain?.state === "ready") return <ReadyBrain brain={brain} active={active} services={services} />;
  return (
    <div className="settings-group">
      {brain ? <BrainState brain={brain} place={place} /> : null}
      <Failure error={status.error} />
    </div>
  );
}

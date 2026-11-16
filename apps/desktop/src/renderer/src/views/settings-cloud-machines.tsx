import { useEffect, useState } from "react";
import type { AccountStatus, CloudMachine, CloudMachines } from "@openorc/protocol";
import { Button } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow } from "./settings-shared";

/** Machines and their hours change slowly; how long one has been awake is counted here between reads. */
const REFRESH_MS = 30_000;
/** While a machine wakes, goes to sleep or was just stopped here, it is read again this soon, until it settles. */
const SETTLING_MS = 3_000;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Hours to a tenth, as the hours a person has are counted. */
const hours = (seconds: number) => `${Math.round(seconds / 360) / 10} h`;

/** The title of a machine's one thread, when that names it; otherwise it is named by its service. */
function threadName(machine: CloudMachine): string | null {
  const [only, ...more] = machine.threads;
  return only && !more.length ? only.title : null;
}

/** How long it has been awake, and where; a machine named by its service says its threads instead, the ones the person reads by name. */
function details(machine: CloudMachine, now: number): string {
  const awake = `Awake for ${duration(now - machine.since)}`;
  if (threadName(machine)) return `${awake} · On ${machine.serviceName}`;
  const count = machine.threads.length === 1 ? "1 thread" : `${machine.threads.length} threads`;
  const titles = machine.threads.flatMap((thread) => (thread.title ? [thread.title] : [])).join(", ");
  return [awake, machine.threads.length ? count : null, titles || null].filter(Boolean).join(" · ");
}

function MachineRow({ machine, now, onStopped }: { machine: CloudMachine; now: number; onStopped: (id: string) => void }) {
  const stop = useRpcMutation("cloudMachines.stop");
  const held = machine.stop.can ? undefined : machine.stop.reason;
  return (
    <>
      <SettingRow label={threadName(machine) ?? `Your machine on ${machine.serviceName}`} hint={<span className="block truncate">{details(machine, now)}</span>}>
        <span className="text-ink-2 tabular-nums">{hours(machine.seconds)} used</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={held !== undefined || stop.isPending}
          data-tip={held}
          onClick={() =>
            stop.mutate(
              { id: machine.id },
              {
                onSuccess: (machines) => {
                  onStopped(machine.id);
                  queryClient.setQueryData(["cloudMachines.read", {}], machines);
                },
              },
            )
          }
        >
          Stop
        </Button>
      </SettingRow>
      <Failure error={stop.error} />
    </>
  );
}

/** Soon while a listed machine is changing or was stopped here and is still listed; otherwise at the slow pace. */
function readAgainIn(data: CloudMachines | undefined, stopped: ReadonlySet<string>): number {
  const machines = data?.state === "ready" ? data.machines : [];
  return machines.some((machine) => machine.changing || stopped.has(machine.id)) ? SETTLING_MS : REFRESH_MS;
}

/** This month's included hours, used of granted; without them, the hours the person has left. */
function monthHint(account: AccountStatus | undefined): string | null {
  const left = account?.state === "signed-in" ? account.hours : null;
  if (!left) return null;
  if (left.monthly) return `${hours(left.monthly.grantedSeconds - left.monthly.leftSeconds)} of ${hours(left.monthly.grantedSeconds)}`;
  return `${hours(left.leftSeconds)} left`;
}

/** The machines awake for the person now, what each has used this time, and Stop. Absent where the server lists none. */
export function CloudMachinesSection({ active }: { active: boolean }) {
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const machines = useRpc("cloudMachines.read", {}, { enabled: active, refetchInterval: (query) => (active ? readAgainIn(query.state.data, stopped) : false) });
  const month = monthHint(useRpc("account.status", {}, { enabled: active }).data);
  const now = useNow(REFRESH_MS);
  if (machines.error) return <Failure error={machines.error} />;
  if (machines.data?.state !== "ready") return null;
  const list = machines.data.machines;
  return (
    <Section title="Machines">
      {list.map((machine) => (
        <MachineRow key={machine.id} machine={machine} now={now} onStopped={(id) => setStopped((was) => new Set([...was, id]))} />
      ))}
      {list.length ? null : <SettingRow label="Nothing is running">{null}</SettingRow>}
      {month ? (
        <SettingRow label="This month">
          <span className="text-ink-2 tabular-nums">{month}</span>
        </SettingRow>
      ) : null}
    </Section>
  );
}

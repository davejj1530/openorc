import { useEffect, useState } from "react";
import type { AccountStatus, CloudMachine } from "@openorc/protocol";
import { Button } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow } from "./settings-shared";

/** Machines and their hours change slowly; how long one has been awake is counted here between reads. */
const REFRESH_MS = 30_000;

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

/** A machine by its one thread, or by its service when it holds several or one they can't open. */
function nameOf(machine: CloudMachine): string {
  const [only, ...more] = machine.threads;
  if (only && !more.length && only.title) return only.title;
  return `Your machine on ${machine.serviceName}`;
}

function details(machine: CloudMachine, now: number): string {
  const threads = machine.threads.length > 1 ? `${machine.threads.length} threads` : null;
  return [`Awake for ${duration(now - machine.since)}`, `On ${machine.serviceName}`, threads].filter(Boolean).join(" · ");
}

function MachineRow({ machine, now }: { machine: CloudMachine; now: number }) {
  const stop = useRpcMutation("cloudMachines.stop");
  const held = machine.stop.can ? undefined : machine.stop.reason;
  return (
    <>
      <SettingRow label={nameOf(machine)} hint={details(machine, now)}>
        <span className="text-ink-2 tabular-nums">{hours(machine.seconds)} used</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={held !== undefined || stop.isPending}
          data-tip={held}
          onClick={() => stop.mutate({ id: machine.id }, { onSuccess: (machines) => queryClient.setQueryData(["cloudMachines.read", {}], machines) })}
        >
          Stop
        </Button>
      </SettingRow>
      <Failure error={stop.error} />
    </>
  );
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
  const machines = useRpc("cloudMachines.read", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const month = monthHint(useRpc("account.status", {}, { enabled: active }).data);
  const now = useNow(REFRESH_MS);
  if (machines.error) return <Failure error={machines.error} />;
  if (machines.data?.state !== "ready") return null;
  const list = machines.data.machines;
  return (
    <Section title="Machines">
      {list.map((machine) => (
        <MachineRow key={machine.id} machine={machine} now={now} />
      ))}
      {list.length ? null : <p className="settings-hint py-3">Nothing is running.</p>}
      {month ? (
        <SettingRow label="This month">
          <span className="text-ink-2 tabular-nums">{month}</span>
        </SettingRow>
      ) : null}
    </Section>
  );
}

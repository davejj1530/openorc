import { useEffect, useState } from "react";
import type { CloudSandbox } from "@openorc/protocol";
import { TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Section, SettingRow } from "./settings-shared";

/** Costs and states change slowly; a running sandbox's awake time is counted here between refreshes. */
const REFRESH_MS = 30_000;

const stateLabels: Record<Exclude<CloudSandbox["state"], "running">, string> = {
  starting: "Starting",
  stopping: "Going to sleep",
  stopped: "Asleep",
  failed: "Failed",
};

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

function usd(amount: number): string {
  return amount > 0 && amount < 0.01 ? "under $0.01" : `$${amount.toFixed(2)}`;
}

/** Where a sandbox runs, said when it is not Vercel. */
const places: Record<CloudSandbox["provider"], string | null> = { local: "Simulated on this Mac", agent37: "On Agent37", vercel: null };

/** Awake now and for how long, or asleep and how long it ran in all; then its size, and where it runs when not on Vercel. */
function details(sandbox: CloudSandbox, now: number): string {
  const awake = sandbox.awakeSince === null ? null : `Awake for ${duration(now - sandbox.awakeSince)}`;
  const resting = sandbox.state === "running" ? "Awake" : stateLabels[sandbox.state];
  const ran = sandbox.awakeMs > 0 ? `, awake ${duration(sandbox.awakeMs)} in all` : "";
  const size = sandbox.vcpus ? `${sandbox.vcpus} vCPUs · ${Math.round((sandbox.memoryMb ?? sandbox.vcpus * 2048) / 1024)} GB` : null;
  return [awake ?? `${resting}${ran}`, size, places[sandbox.provider], sandbox.thread ? null : "No conversation"].filter(Boolean).join(" · ");
}

function SandboxRow({ sandbox, now }: { sandbox: CloudSandbox; now: number }) {
  const remove = useRpcMutation("cloud.sandboxes.remove");
  return (
    <>
      <SettingRow label={sandbox.thread?.title ?? sandbox.name} hint={details(sandbox, now)}>
        {sandbox.costUsd === null ? null : <span className="text-ink-2 tabular-nums">{usd(sandbox.costUsd)}</span>}
        <TextButton
          tone="muted"
          disabled={sandbox.working || remove.isPending}
          title={sandbox.working ? "Its agent is at work there" : undefined}
          onClick={() => remove.mutate({ name: sandbox.name })}
        >
          Remove
        </TextButton>
      </SettingRow>
      {remove.error ? (
        <p role="alert" className="text-bad mt-2">
          {remove.error.message}
        </p>
      ) : null}
    </>
  );
}

function summary(sandboxes: CloudSandbox[]): string | undefined {
  const priced = sandboxes.filter((sandbox) => sandbox.costUsd !== null);
  if (priced.length === 0) return undefined;
  return `About ${usd(priced.reduce((sum, sandbox) => sum + (sandbox.costUsd ?? 0), 0))} so far, at Vercel's list prices.`;
}

/** OpenOrc's sandboxes: whether each is awake, what it has cost, and removing it. A conversation's next message makes a new one. */
export function CloudSandboxesSection({ active }: { active: boolean }) {
  const sandboxes = useRpc("cloud.sandboxes", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const now = useNow(REFRESH_MS);
  const list = sandboxes.data ?? [];
  return (
    <Section title="Sandboxes" description={summary(list)}>
      {list.map((sandbox) => (
        <SandboxRow key={`${sandbox.provider}:${sandbox.name}`} sandbox={sandbox} now={now} />
      ))}
      {sandboxes.data && list.length === 0 ? <p className="settings-hint py-2">No sandboxes.</p> : null}
      {sandboxes.error ? (
        <p role="alert" className="text-bad mt-2">
          {sandboxes.error.message}
        </p>
      ) : null}
    </Section>
  );
}

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

/** Where a sandbox runs, so a row from one connected service is never taken for the other's. */
const places: Record<CloudSandbox["provider"], string> = { local: "Simulated on this Mac", agent37: "On Agent37", vercel: "On Vercel" };

/** Awake now and for how long, or asleep and how long it ran in all; then its size, and where it runs. */
function details(sandbox: CloudSandbox, now: number): string {
  const awake = sandbox.awakeSince === null ? null : `Awake for ${duration(now - sandbox.awakeSince)}`;
  const resting = sandbox.state === "running" ? "Awake" : stateLabels[sandbox.state];
  const ran = sandbox.awakeMs > 0 ? `, awake ${duration(sandbox.awakeMs)} in all` : "";
  const size = sandbox.vcpus ? `${sandbox.vcpus} vCPUs · ${Math.round((sandbox.memoryMb ?? sandbox.vcpus * 2048) / 1024)} GB` : null;
  return [awake ?? `${resting}${ran}`, size, places[sandbox.provider], sandbox.thread ? null : "No thread"].filter(Boolean).join(" · ");
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
          Delete sandbox
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

/** How each service's total is counted: Vercel's estimated at its list prices, Agent37's as Agent37 counts it. */
const COUNTED: Partial<Record<CloudSandbox["provider"], (amount: number) => string>> = {
  vercel: (amount) => `Vercel ${amount > 0 && amount < 0.01 ? "under $0.01" : `about ${usd(amount)}`} at list prices`,
  agent37: (amount) => `Agent37 ${usd(amount)}`,
};

/** What the sandboxes cost so far, each service on its own; nothing while none is priced. */
function spent(sandboxes: CloudSandbox[]): string | null {
  const parts = (Object.keys(COUNTED) as CloudSandbox["provider"][]).flatMap((provider) => {
    const priced = sandboxes.filter((sandbox) => sandbox.provider === provider && sandbox.costUsd !== null);
    return priced.length ? [COUNTED[provider]!(priced.reduce((sum, sandbox) => sum + (sandbox.costUsd ?? 0), 0))] : [];
  });
  return parts.length ? parts.join(" · ") : null;
}

/** OpenOrc's sandboxes: whether each is awake, where, what it has cost, and removing it. A conversation's next message makes a new one. */
export function CloudSandboxesSection({ active }: { active: boolean }) {
  const sandboxes = useRpc("cloud.sandboxes", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const now = useNow(REFRESH_MS);
  const list = sandboxes.data ?? [];
  const total = spent(list);
  return (
    <Section title="Cloud threads" description="Each runs in a sandbox of its own and stays on its service. Delete a sandbox and the thread's next message makes a new one where new threads run now.">
      {list.map((sandbox) => (
        <SandboxRow key={`${sandbox.provider}:${sandbox.name}`} sandbox={sandbox} now={now} />
      ))}
      {sandboxes.data && list.length === 0 ? <p className="settings-hint py-2">No cloud threads yet.</p> : null}
      {total ? (
        <SettingRow label="So far">
          <span className="text-ink-2 tabular-nums">{total}</span>
        </SettingRow>
      ) : null}
      {sandboxes.error ? (
        <p role="alert" className="text-bad mt-2">
          {sandboxes.error.message}
        </p>
      ) : null}
    </Section>
  );
}

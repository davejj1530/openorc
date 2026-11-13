import { useEffect, useRef, useState, type ReactNode } from "react";
import { missingCloudSignIn, type CloudTurnWho } from "@openorc/client";
import { signInKey, signInTarget, type CloudSignIn } from "@openorc/protocol";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { core } from "../lib/rpc";
import { Button, Input, TextButton } from "./ui";
import { thisComputer } from "../lib/this-computer";

const card = "rounded-xl bg-surface px-3.5 py-1.5 text-base";

/** A send the person called off while it waited: no words, so the composer keeps the message and shows nothing. */
class SendCalledOff extends Error {
  constructor() {
    super("");
  }
}

function asked(row: CloudSignIn): string {
  if (row.kind === "claude") return `Claude account “${row.label}” has no sign-in for the cloud.`;
  if (row.kind === "codex") return "Codex has no sign-in for the cloud.";
  if (row.kind === "brain-codex") return "Codex has no sign-in on the cloud brain.";
  return `There is no ${row.label} key for the cloud.`;
}

const WAITING: Partial<Record<CloudSignIn["way"], string>> = { browser: "Sign in in your browser.", "private-window": "Sign in in the private window that opened." };

/** A key typed in, for a provider this Mac signs in to with an account. */
function KeyField({ provider }: { provider: string }) {
  const save = useRpcMutation("cloud.opencode.saveKey");
  const [key, setKey] = useState("");
  return (
    <span className="flex items-center gap-2">
      <Input type="password" aria-label="API key" autoComplete="off" spellCheck={false} placeholder="Paste key" value={key} disabled={save.isPending} onChange={(e) => setKey(e.target.value)} />
      <Button disabled={save.isPending || !key.trim()} onClick={() => save.mutate({ provider, key: key.trim() })}>
        Save
      </Button>
    </span>
  );
}

/** The one sign-in a waiting send needs, offered where the person sent it. */
function Offer({ row, onCancel }: { row: CloudSignIn; onCancel: () => void }) {
  const bring = useRpcMutation("cloud.signIns.bring");
  const working = row.state === "working";
  let action: ReactNode;
  if (row.way === "key" && row.kind === "opencode") action = <KeyField provider={row.provider} />;
  else if (!working)
    action = (
      <Button variant="primary" disabled={bring.isPending} onClick={() => bring.mutate({ target: signInTarget(row) })}>
        {row.way === "copy" ? `Copy ${thisComputer}'s key` : "Sign in"}
      </Button>
    );
  const note = bring.error?.message ?? row.error ?? (working ? WAITING[row.way] : null);
  return (
    <section role="status" aria-label="Cloud sign-in" data-plane className={card}>
      <div className="pt-1.5 text-ink">{asked(row)}</div>
      {note ? <p className="py-1 text-ink-3">{note}</p> : null}
      <div className="flex flex-wrap items-center gap-2 py-1.5">
        {action}
        <TextButton tone="muted" onClick={onCancel}>
          Cancel
        </TextButton>
      </div>
    </section>
  );
}

interface Held {
  row: CloudSignIn;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * A cloud send that needs a sign-in the cloud lacks waits for it here, with that one sign-in offered in place, and goes
 * once it is ready. `who` is null for a send that does not run in the cloud. Leaving the view or Cancel calls the send
 * off, and the composer keeps the message.
 */
export function useCloudSignInGate(who: CloudTurnWho | null): { ready: () => Promise<void>; offer: ReactNode } {
  const [held, setHeld] = useState<Held | null>(null);
  // Read again as the rows change only while a send waits; `ready` reads them fresh itself.
  const signIns = useRpc("cloud.signIns", {}, { enabled: held !== null });
  const kept = useRef<Held | null>(null);
  kept.current = held;
  const row = held && (signIns.data?.rows.find((each) => signInKey(each) === signInKey(held.row)) ?? held.row);
  useEffect(() => {
    if (!held || row?.state !== "ready") return;
    setHeld(null);
    held.resolve();
  }, [held, row?.state]);
  useEffect(() => () => kept.current?.reject(new SendCalledOff()), []);
  const ready = async () => {
    if (!who) return;
    const fresh = await core.call("cloud.signIns", {});
    queryClient.setQueryData(["cloud.signIns", {}], fresh);
    const missing = missingCloudSignIn(fresh, who);
    if (missing) await new Promise<void>((resolve, reject) => setHeld({ row: missing, resolve, reject }));
  };
  const cancel = () => {
    setHeld(null);
    held?.reject(new SendCalledOff());
  };
  return { ready, offer: row ? <Offer row={row} onCancel={cancel} /> : null };
}

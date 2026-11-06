import { useState } from "react";
import type { RemoteDevice } from "@openorc/protocol";
import { Button, Dialog } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { PairingCode, PhoneRow, pairingSheet, useTicker } from "./settings-phone";
import { Section, SettingRow } from "./settings-shared";

/** Asked as often as the brain's status; the core asks the brain itself at most once a minute, never waking it. */
const REFRESH_MS = 30_000;

function BrainPhone({ device, busy }: { device: RemoteDevice; busy: boolean }) {
  return <PhoneRow device={device} remove={useRpcMutation("cloud.brain.phones.remove")} disabled={busy} />;
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

/** What the pairing row says: pair again after a move, the first phone, or another one. */
function pairRow(again: boolean, phones: number): { label: string; hint?: string } {
  if (again) return { label: "Pair your phone again", hint: "Phones paired before the move can't reach it." };
  return phones ? { label: "Another phone" } : { label: "Your phone", hint: "Scan a code with the OpenOrc app." };
}

/** The phones paired with the brain, as this Mac last heard them, each with the Phone page's Remove, and pairing one. */
export function CloudBrainPhones({ active, busy, again }: { active: boolean; busy: boolean; again: boolean }) {
  const phones = useRpc("cloud.brain.phones", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  const pairing = pairRow(again, phones.data?.length ?? 0);
  return (
    <Section title="Phones">
      {phones.data?.map((device) => (
        <BrainPhone key={device.id} device={device} busy={busy} />
      ))}
      <SettingRow label={pairing.label} hint={pairing.hint}>
        <PairBrainPhone disabled={busy} />
      </SettingRow>
    </Section>
  );
}

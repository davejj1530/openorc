import type { RemoteDevice } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { PhoneRow } from "./settings-phone";

/** Asked as often as the brain's status; the core asks the brain itself at most once a minute, never waking it. */
const REFRESH_MS = 30_000;

function BrainPhone({ device, busy }: { device: RemoteDevice; busy: boolean }) {
  return <PhoneRow device={device} remove={useRpcMutation("cloud.brain.phones.remove")} disabled={busy} />;
}

/** The phones paired with the brain, as this Mac last heard them, each with the Phone page's Remove. */
export function CloudBrainPhones({ active, busy }: { active: boolean; busy: boolean }) {
  const phones = useRpc("cloud.brain.phones", {}, { enabled: active, refetchInterval: active ? REFRESH_MS : false });
  return (
    <>
      {phones.data?.map((device) => (
        <BrainPhone key={device.id} device={device} busy={busy} />
      ))}
    </>
  );
}

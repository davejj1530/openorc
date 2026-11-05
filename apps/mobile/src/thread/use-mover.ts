import { useContext, useMemo } from "react";
import { useHostGroup, useSavedMacs } from "../client";
import { HostContext } from "../connection/host-context";
import { moverOf } from "../connection/hosts";

/** The Mac that moves this screen's threads between itself and its cloud brain, as the group and saved hosts change. */
export function useMover(): { mac: string; onBrain: boolean } | null {
  const host = useContext(HostContext);
  const { primary, partner } = useHostGroup();
  const mover = moverOf(useSavedMacs(), { primary, partner }, host);
  const mac = mover?.mac ?? null;
  const onBrain = mover?.onBrain ?? false;
  return useMemo(() => (mac ? { mac, onBrain } : null), [mac, onBrain]);
}

import type { AppSettings, HarnessId } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { useRpc, useRpcMutation } from "./client";
import { readOnboardingState, type PersistedOnboardingState } from "./onboarding";

/*
 * New work follows the core's enabled agents and default harness. Older desktop profiles hold these choices only in
 * onboarding's local state; App hands them over once, then shared settings own later changes.
 */

/** The harness New thread offers first, or undefined until the core's settings load. */
export function useDefaultHarness(): HarnessId | null | undefined {
  const settings = useRpc("app.settings.get", {});
  // Until App hands an earlier onboarding choice to the core, that choice still decides.
  return settings.data && (settings.data.defaultHarness ?? (settings.data.enabledHarnesses == null ? readOnboardingState().defaultHarness : null));
}

/**
 * Migrate choices the core does not hold yet, then save both choices whenever onboarding changes them. Decide migration
 * once so an older local choice never replaces a later change in Connections, including disabling every agent.
 */
export function useOnboardingAgents(): (state: Pick<PersistedOnboardingState, "defaultHarness" | "selectedHarnesses">) => void {
  const settings = useRpc("app.settings.get", {});
  const { mutate: save } = useRpcMutation("app.settings.set");
  const [earlier] = useState(readOnboardingState);
  const decided = useRef(false);
  const current = settings.data;
  useEffect(() => {
    if (current === undefined || decided.current) return;
    decided.current = true;
    const patch: Partial<AppSettings> = {};
    if (current.enabledHarnesses == null && earlier.selectedHarnesses !== null) patch.enabledHarnesses = [...earlier.selectedHarnesses];
    if (current.defaultHarness === null && current.enabledHarnesses == null && earlier.defaultHarness !== null) patch.defaultHarness = earlier.defaultHarness;
    if (Object.keys(patch).length) save(patch);
  }, [current, earlier, save]);
  return (state) => {
    decided.current = true;
    const sameAgents =
      state.selectedHarnesses === null || (current?.enabledHarnesses?.length === state.selectedHarnesses.length && state.selectedHarnesses.every((id) => current.enabledHarnesses?.includes(id)));
    if (state.defaultHarness !== current?.defaultHarness || !sameAgents)
      save({ defaultHarness: state.defaultHarness, ...(state.selectedHarnesses === null ? {} : { enabledHarnesses: [...state.selectedHarnesses] }) });
  };
}

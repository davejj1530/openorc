import type { HarnessId } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { useRpc, useRpcMutation } from "./client";
import { readOnboardingState } from "./onboarding";

/*
 * New threads on the desktop and on a phone start with the core's `defaultHarness`. Onboarding chooses it and saves it
 * there as well as in its own state. A profile set up before the core kept it has the choice only in onboarding's state.
 */

/** The harness New thread offers first, or undefined until the core's settings load. */
export function useDefaultHarness(): HarnessId | null | undefined {
  const settings = useRpc("app.settings.get", {});
  // Until App hands an earlier onboarding choice to the core, that choice still decides.
  return settings.data && (settings.data.defaultHarness ?? readOnboardingState().defaultHarness);
}

/**
 * For App, which saves onboarding's state: hands a choice saved before this launch to the core if the core's first
 * settings read shows none, and returns what to call with each default onboarding saves from now on. The handover is
 * decided once, so a default onboarding saves later, null included, is never replaced by the older choice.
 */
export function useOnboardingDefaultHarness(): (harness: HarnessId | null) => void {
  const settings = useRpc("app.settings.get", {});
  const { mutate: save } = useRpcMutation("app.settings.set");
  const [earlier] = useState(() => readOnboardingState().defaultHarness);
  const decided = useRef(false);
  const current = settings.data?.defaultHarness;
  useEffect(() => {
    if (current === undefined || decided.current) return;
    decided.current = true;
    if (current === null && earlier !== null) save({ defaultHarness: earlier });
  }, [current, earlier, save]);
  return (harness) => {
    decided.current = true;
    if (harness !== current) save({ defaultHarness: harness });
  };
}

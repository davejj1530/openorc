import { enabledHarnessIds, type HarnessId } from "@openorc/protocol";
import { useRpc } from "./client";
import { readOnboardingState } from "./onboarding";

/** Use onboarding's saved selection while an older profile hands it to the shared settings. */
export function useEnabledHarnesses(allowed?: readonly HarnessId[]): readonly HarnessId[] {
  const settings = useRpc("app.settings.get", {});
  const enabled = enabledHarnessIds({ enabledHarnesses: settings.data?.enabledHarnesses ?? readOnboardingState().selectedHarnesses });
  return allowed ? enabled.filter((id) => allowed.includes(id)) : enabled;
}

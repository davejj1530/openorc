import { harnessIds, type HarnessId, type HarnessInfo } from "@openorc/protocol";

export const ONBOARDING_VERSION = 1 as const;

export type OnboardingStep = "scan" | "default" | "theme" | "project" | "done";

export type PersistedOnboardingState = Readonly<{
  version: typeof ONBOARDING_VERSION;
  step: OnboardingStep;
  completedAt: number | null;
  selectedHarnesses: readonly HarnessId[] | null;
  defaultHarness: HarnessId | null;
}>;

export type OnboardingReason = "harness_required" | "harness_check_failed" | "default_required" | "project_required" | "harness_recovery" | "complete";

export type OnboardingHarness = Pick<HarnessInfo, "id" | "state">;

export interface ResolveOnboardingInput {
  persisted: unknown;
  harnesses: readonly OnboardingHarness[];
  projectCount: number;
}

export type OnboardingResolution = Readonly<{
  mode: "first_run" | "recovery" | "done";
  step: OnboardingStep;
  reason: OnboardingReason;
  state: PersistedOnboardingState;
}>;

const freshState = (): PersistedOnboardingState => ({
  version: ONBOARDING_VERSION,
  step: "scan",
  completedAt: null,
  selectedHarnesses: null,
  defaultHarness: null,
});

const ONBOARDING_STORAGE_KEY = "openorc.onboarding";
const steps: readonly OnboardingStep[] = ["scan", "default", "theme", "project", "done"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function decodeOnboardingState(value: unknown): PersistedOnboardingState {
  if (!object(value) || value.version !== ONBOARDING_VERSION) return freshState();
  if (!steps.includes(value.step as OnboardingStep)) return freshState();
  if (value.completedAt !== null && (typeof value.completedAt !== "number" || !Number.isFinite(value.completedAt) || value.completedAt < 0)) return freshState();
  if (value.defaultHarness !== null && !harnessIds.includes(value.defaultHarness as HarnessId)) return freshState();
  const defaultHarness = value.defaultHarness as HarnessId | null;
  // States written before multi-select only carried the default. Treat it as
  // the sole explicit selection, while a missing default remains uninitialized.
  let selectedHarnesses: HarnessId[] | null | undefined;
  if (value.selectedHarnesses === undefined) {
    selectedHarnesses = defaultHarness === null ? null : [defaultHarness];
  } else if (value.selectedHarnesses === null) {
    selectedHarnesses = null;
  } else if (Array.isArray(value.selectedHarnesses) && value.selectedHarnesses.every((id) => harnessIds.includes(id as HarnessId))) {
    selectedHarnesses = [...new Set(value.selectedHarnesses as HarnessId[])];
  }
  if (selectedHarnesses === undefined) return freshState();
  return {
    version: ONBOARDING_VERSION,
    step: value.step as OnboardingStep,
    completedAt: value.completedAt,
    selectedHarnesses,
    defaultHarness: selectedHarnesses === null || defaultHarness === null || selectedHarnesses.includes(defaultHarness) ? defaultHarness : null,
  };
}

export function readOnboardingState(): PersistedOnboardingState {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    return decodeOnboardingState(raw === null ? null : JSON.parse(raw));
  } catch {
    return freshState();
  }
}

export function writeOnboardingState(state: PersistedOnboardingState): boolean {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(decodeOnboardingState(state)));
    return true;
  } catch {
    return false;
  }
}

export function resolveOnboarding(input: ResolveOnboardingInput): OnboardingResolution {
  const state = decodeOnboardingState(input.persisted);
  const ready = input.harnesses.filter((harness) => harness.state === "ready");
  const readyIds = ready.map((harness) => harness.id);
  const failed = input.harnesses.some((harness) => harness.state === "check_failed");
  const selectedHarnesses = state.selectedHarnesses ?? readyIds;
  const selectedReady = selectedHarnesses.filter((id) => readyIds.includes(id));
  let defaultHarness: HarnessId | null = null;
  if (selectedReady.length === 1) defaultHarness = selectedReady[0]!;
  else if (state.defaultHarness !== null && selectedReady.includes(state.defaultHarness)) defaultHarness = state.defaultHarness;
  const normalized = { ...state, selectedHarnesses, defaultHarness };
  // Existing projects establish prior use; choosing a new default must not block access.
  if (ready.length > 0 && input.projectCount > 0) {
    return {
      mode: "done",
      step: "done",
      reason: "complete",
      state: { ...normalized, step: "done" },
    };
  }
  if (ready.length === 0 && (state.completedAt !== null || input.projectCount > 0)) {
    return {
      mode: "recovery",
      step: "scan",
      reason: failed ? "harness_check_failed" : "harness_recovery",
      state: { ...state, step: "scan" },
    };
  }
  if (state.step === "scan" || state.selectedHarnesses === null || selectedReady.length === 0) {
    return {
      mode: "first_run",
      step: "scan",
      reason: failed ? "harness_check_failed" : "harness_required",
      state: { ...normalized, step: "scan" },
    };
  }
  if (selectedReady.length > 1 && defaultHarness === null) {
    return {
      mode: "first_run",
      step: "default",
      reason: "default_required",
      state: { ...normalized, step: "default" },
    };
  }
  const nextSetupStep = state.step === "project" ? "project" : "theme";
  return {
    mode: "first_run",
    step: nextSetupStep,
    reason: "project_required",
    state: { ...normalized, step: nextSetupStep },
  };
}

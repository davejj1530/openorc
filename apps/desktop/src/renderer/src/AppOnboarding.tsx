import type { RpcResults } from "@openorc/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "./components/SidebarListHead";
import { useRpc } from "./lib/client";
import { useOnboardingAgents } from "./lib/default-harness";
import { readOnboardingState, resolveOnboarding, writeOnboardingState, type PersistedOnboardingState } from "./lib/onboarding";
import { useOrganization } from "./lib/organization-context";
import { useRouter } from "./lib/router";
import { useTrafficLights } from "./lib/window";
import { Onboarding } from "./views/Onboarding";

function requestedOnboarding(onboarding: ReturnType<typeof resolveOnboarding> | null, systemError: boolean, projectsError: boolean): "first_run" | "recovery" | null {
  if (onboarding) return onboarding.mode === "done" ? null : onboarding.mode;
  if (systemError || projectsError) return "recovery";
  return null;
}

function useAppOnboarding() {
  const route = useRouter((state) => state.route);
  const organization = useOrganization()?.organization;
  const system = useRpc("system.info", { refresh: false });
  const projects = useRpc("projects.list", {});
  const [savedOnboarding, setOnboardingState] = useState(readOnboardingState);
  const settings = useRpc("app.settings.get", {});
  const onboardingState = setupState(savedOnboarding, settings.data);
  const recordAgents = useOnboardingAgents();
  const [onboardingSession, setOnboardingSession] = useState<"first_run" | "recovery" | "dismissed" | null>(null);
  const onboarding = availableOnboarding(system.data, projects.data, onboardingState);
  const automaticOnboarding = route.view === "newthread" && !route.projectId && !organization;
  const automaticOnboardingEnabled = automaticOnboarding && onboardingSession !== "dismissed";
  const requestedOnboardingMode = requestedOnboarding(onboarding, system.isError, projects.isError);
  const onboardingMode = onboardingSession === "first_run" || onboardingSession === "recovery" ? onboardingSession : requestedOnboardingMode;

  // Wait for a resolved check, then keep the current flow mounted until the user exits.
  useEffect(() => {
    if (automaticOnboardingEnabled && onboardingSession === null && requestedOnboardingMode) {
      setOnboardingSession(requestedOnboardingMode);
    }
  }, [automaticOnboardingEnabled, onboardingSession, requestedOnboardingMode]);

  const dismissOnboarding = () => {
    setOnboardingSession("dismissed");
    if (route.view === "onboarding") {
      const router = useRouter.getState();
      if (router.history.length > 0) router.back();
      else router.navigate({ view: "newthread" });
    }
  };
  const persistOnboarding = (next: PersistedOnboardingState): boolean => {
    if (!writeOnboardingState(next)) return false;
    setOnboardingState(next);
    recordAgents(next);
    return true;
  };
  return { onboardingState, onboarding, automaticOnboardingEnabled, onboardingMode, system, projects, dismissOnboarding, persistOnboarding };
}

export function AppOnboarding({ children }: { children: ReactNode }) {
  const route = useRouter((state) => state.route);
  const trafficLights = useTrafficLights();
  const { onboardingState, onboarding, automaticOnboardingEnabled, onboardingMode, system, projects, dismissOnboarding, persistOnboarding } = useAppOnboarding();
  if (route.view === "onboarding") {
    return <Onboarding mode={route.mode ?? "first_run"} previewInitially={route.preview ?? false} persisted={onboardingState} onPersist={persistOnboarding} onComplete={dismissOnboarding} />;
  }

  if (automaticOnboardingEnabled && !onboardingMode && !onboarding && !system.isError && !projects.isError) {
    return (
      <div className="onboarding-root">
        <header className="onboarding-chrome" data-traffic-lights={trafficLights || undefined}>
          <span className="onboarding-brand">
            <Wordmark />
          </span>
        </header>
        <main className="onboarding-surface">
          <div className="document-skeleton" aria-label="Checking setup" />
        </main>
      </div>
    );
  }

  if (automaticOnboardingEnabled && onboardingMode) {
    return (
      <Onboarding
        key={onboardingMode}
        mode={onboardingMode}
        initialStep={onboarding?.step}
        persisted={onboarding?.state ?? onboardingState}
        onPersist={persistOnboarding}
        onComplete={dismissOnboarding}
      />
    );
  }

  return children;
}

function setupState(saved: PersistedOnboardingState, settings: RpcResults["app.settings.get"] | undefined) {
  return settings?.enabledHarnesses == null ? saved : { ...saved, selectedHarnesses: settings.enabledHarnesses, defaultHarness: settings.defaultHarness };
}
function availableOnboarding(system: RpcResults["system.info"] | undefined, projects: RpcResults["projects.list"] | undefined, persisted: PersistedOnboardingState) {
  if (!system || !projects) return null;
  return resolveOnboarding({ persisted, harnesses: system.harnesses, projectCount: projects.length });
}

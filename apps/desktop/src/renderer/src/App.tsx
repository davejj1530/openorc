import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { DeleteThreadDialog } from "./components/ThreadActions";
import { TeamMoveDialog } from "./components/TeamMoveDialog";
import { ThreadMoveDialog } from "./components/ThreadMoveDialog";
import { ImportProjectDialog } from "./dialogs/ImportProjectDialog";
import { ImportSessionsDialog } from "./dialogs/ImportSessionsDialog";
import { useLayout } from "./lib/layout";
import { readOnboardingState, resolveOnboarding, writeOnboardingState, type PersistedOnboardingState } from "./lib/onboarding";
import { useRpc } from "./lib/query";
import { core } from "./lib/rpc";
import { newThread, openThread, useRouter, type Route } from "./lib/router";
import { useUi } from "./lib/ui";
import { useTrafficLights } from "./lib/window";
import { Inbox } from "./views/Inbox";
import { Memory } from "./views/Memory";
import { NewThread } from "./views/NewThread";
import { Onboarding } from "./views/Onboarding";
import { Orchestration } from "./views/Orchestration";
import { OrclingDesigner } from "./views/OrclingDesigner";
import { ProjectView } from "./views/ProjectView";
import { PullRequestList } from "./views/PullRequestList";
import { PullRequestView } from "./views/PullRequestView";
import { Scheduled } from "./views/Scheduled";
import { Settings } from "./views/Settings";
import { AgentUpdateNotice } from "./views/settings-agent-updates";
import { AppUpdateNotice } from "./components/AppUpdateNotice";
import { TaskListView } from "./views/TaskList";
import { ThreadWorkspace } from "./components/ThreadWorkspace";

// The diagnostics screen and its benchmark controls ship only in development and QA builds.
const Diagnostics = __OPENORC_QA__ ? lazy(() => import("./views/Diagnostics").then((m) => ({ default: m.Diagnostics }))) : null;
const NewTask = lazy(() => import("./views/NewTask").then((m) => ({ default: m.NewTask })));
const TaskView = lazy(() => import("./views/TaskView").then((m) => ({ default: m.TaskView })));

/** ⌘⇧ shortcuts that act on the open thread, as in the Codex and t3code sidebars. */
function threadShortcut(key: string, threadId: string): boolean {
  const patch = (p: { pinned?: boolean; archived?: boolean; seen?: boolean }) => void core.call("threads.update", { id: threadId, patch: p });
  const current = () => core.call("threads.get", { id: threadId });
  switch (key) {
    case "p":
      void current().then((t) => t && patch({ pinned: !t.pinnedAt }));
      return true;
    case "a":
      void current().then((t) => t && patch({ archived: !t.archivedAt }));
      return true;
    case "u":
      void current().then((t) => t && patch({ seen: t.unread }));
      return true;
    default:
      return false;
  }
}

/** ⌘⇧ shortcuts that act on the window: a new task, message search, and orcmode in the sidebar. */
function windowShortcut(key: string, projectId: string | undefined): boolean {
  switch (key) {
    case "n":
      useUi.getState().openNewTask(projectId);
      return true;
    case "f":
      useUi.getState().setPalette(true, "messages");
      return true;
    case "o":
      useLayout.getState().toggleOrcMode();
      return true;
    default:
      return false;
  }
}

function projectForRoute(route: ReturnType<typeof useRouter.getState>["route"], savedProjectId: string | null): string | undefined {
  if (route.view === "project" || route.view === "newthread" || route.view === "newtask" || route.view === "orchestration") return route.projectId;
  return savedProjectId ?? undefined;
}

function requestedOnboarding(onboarding: ReturnType<typeof resolveOnboarding> | null, systemError: boolean, projectsError: boolean): "first_run" | "recovery" | null {
  if (onboarding) return onboarding.mode === "done" ? null : onboarding.mode;
  if (systemError || projectsError) return "recovery";
  return null;
}

/**
 * Navigation, a workspace of up to three conversations, and one shared panel.
 * Task screens keep their own panel; other screens use the main column alone.
 */
export function App() {
  const trafficLights = useTrafficLights();
  const route = useRouter((s) => s.route);
  const ui = useUi();
  const projectId = useLayout((s) => s.projectId);
  const system = useRpc("system.info", { refresh: false });
  const projects = useRpc("projects.list", {});
  const [onboardingState, setOnboardingState] = useState(readOnboardingState);
  const [onboardingSession, setOnboardingSession] = useState<"first_run" | "recovery" | "dismissed" | null>(null);
  const currentProject = projectForRoute(route, projectId);
  const onboarding =
    system.data && projects.data
      ? resolveOnboarding({
          persisted: onboardingState,
          harnesses: system.data.harnesses,
          projectCount: projects.data.length,
        })
      : null;
  const automaticOnboarding = route.view === "newthread" && !route.projectId;
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
    return true;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const order = useUi.getState().threadOrder;
      const openId = useRouter.getState().route.view === "thread" ? (useRouter.getState().route as { threadId: string }).threadId : null;
      if (e.shiftKey) {
        if (key === "]" || key === "[") {
          e.preventDefault();
          const at = openId ? order.indexOf(openId) : -1;
          const next = order[key === "]" ? Math.min(order.length - 1, at + 1) : Math.max(0, at - 1)];
          if (next && next !== openId) openThread(next);
        } else if (windowShortcut(key, currentProject) || (openId && threadShortcut(key, openId))) e.preventDefault();
        return;
      }
      if (key === "n") {
        e.preventDefault();
        newThread(currentProject);
      } else if (key === "b") {
        e.preventDefault();
        useLayout.getState().toggleSidebar();
      } else if (key === "j") {
        e.preventDefault();
        const l = useLayout.getState();
        if (openId) l.toggleThreadPanel(openId);
        else l.setPanel(!l.panelOpen);
      } else if (key === "[") {
        e.preventDefault();
        useRouter.getState().back();
      } else if (key === "]") {
        e.preventDefault();
        useRouter.getState().forward();
      } else if (key === "\\") {
        e.preventDefault();
        useRouter.getState().closeOtherThreadPanes();
      } else if (/^[1-9]$/.test(key)) {
        const id = order[Number(key) - 1];
        if (id) {
          e.preventDefault();
          openThread(id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentProject]);

  if (route.view === "onboarding") {
    return <Onboarding mode={route.mode ?? "first_run"} previewInitially={route.preview ?? false} persisted={onboardingState} onPersist={persistOnboarding} onComplete={dismissOnboarding} />;
  }

  if (automaticOnboardingEnabled && !onboardingMode && !onboarding && !system.isError && !projects.isError) {
    return (
      <div className="onboarding-root">
        <header className="onboarding-chrome" data-traffic-lights={trafficLights || undefined}>
          <span className="onboarding-brand">OpenOrc</span>
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

  return (
    <div className="app-shell h-full flex text-ink">
      <Sidebar />
      <div className="work-row flex-1 min-w-0 h-full flex">
        {route.view === "newthread" ? <NewThread key={route.projectId ?? ""} projectId={route.projectId} /> : null}
        {route.view === "newtask" ? (
          <Main>
            <Suspense fallback={<div className="document-skeleton" aria-label="Loading editor" />}>
              <NewTask key={`${route.projectId ?? ""}:${route.threadId ?? ""}`} projectId={route.projectId} threadId={route.threadId} />
            </Suspense>
          </Main>
        ) : null}
        {route.view === "thread" ? <ThreadWorkspace /> : null}
        {route.view === "task" ? (
          <Suspense
            fallback={
              <Main>
                <div className="document-skeleton" aria-label="Loading task" />
              </Main>
            }
          >
            <TaskView key={route.taskId} taskId={route.taskId} tab={route.tab} />
          </Suspense>
        ) : null}
        <MainScreen route={route} currentProject={currentProject} />
      </div>
      <CommandPalette open={ui.palette} onOpenChange={ui.setPalette} />
      <div className="workspace-update-notices">
        <AppUpdateNotice />
        <AgentUpdateNotice />
      </div>
      <ImportProjectDialog open={ui.importProject} onOpenChange={ui.setImportProject} />
      <ImportSessionsDialog open={ui.importSessions.open} projectId={ui.importSessions.projectId ?? currentProject} onOpenChange={(open) => ui.setImportSessions(open)} />
      <DeleteThreadDialog />
      <TeamMoveDialog />
      <ThreadMoveDialog />
    </div>
  );
}

/** The screens that use the main column alone. */
function MainScreen({ route, currentProject }: { route: Route; currentProject: string | undefined }) {
  const openNewTask = useUi((s) => s.openNewTask);
  let screen: ReactNode;
  switch (route.view) {
    case "inbox":
      screen = <Inbox />;
      break;
    case "tasks":
      screen = <TaskListView onNewTask={() => openNewTask(currentProject)} />;
      break;
    case "pulls":
      screen = <PullRequestList />;
      break;
    case "pull":
      screen = <PullRequestView key={`${route.projectId}:${route.number}`} projectId={route.projectId} number={route.number} />;
      break;
    case "project":
      screen = <ProjectView projectId={route.projectId} onNewTask={() => openNewTask(route.projectId)} />;
      break;
    case "memory":
      screen = <Memory />;
      break;
    case "scheduled":
      screen = <Scheduled />;
      break;
    case "orchestration":
      screen = <Orchestration projectId={route.projectId} teamId={route.teamId} />;
      break;
    case "orcling":
      screen = <OrclingDesigner orclingId={route.orclingId} />;
      break;
    case "settings":
      screen = <Settings route={route} />;
      break;
    case "diagnostics":
      screen = Diagnostics ? (
        <Suspense fallback={null}>
          <Diagnostics />
        </Suspense>
      ) : null;
      break;
    default:
      screen = null;
  }
  return screen ? <Main>{screen}</Main> : null;
}

/** The main column for screens without a panel. */
export function Main({ children }: { children: React.ReactNode }) {
  return <main className="well flex-1 min-w-0 flex flex-col">{children}</main>;
}

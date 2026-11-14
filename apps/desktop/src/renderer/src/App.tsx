import { AppOnboarding } from "./AppOnboarding";
import { lazy, Suspense, type ReactNode } from "react";
import { AppUpdateNotice } from "./components/AppUpdateNotice";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { OrganizationProvider } from "./components/OrganizationProvider";
import { OrganizationPeople } from "./views/OrganizationPeople";
import { OrganizationStart } from "./views/OrganizationStart";
import { useOrganization } from "./lib/organization-context";
import { DeleteThreadDialog } from "./components/ThreadActions";
import { ThreadMoveDialog } from "./components/ThreadMoveDialog";
import { RemoveWorktreeDialog } from "./components/RemoveWorktreeDialog";
import { ThreadWorkspace } from "./components/ThreadWorkspace";
import { TooltipProvider } from "./components/ui";
import { ImportProjectDialog } from "./dialogs/ImportProjectDialog";
import { ImportSessionsDialog } from "./dialogs/ImportSessionsDialog";
import { NewFileDialog } from "./dialogs/NewFileDialog";
import { useAppShortcuts } from "./lib/app-shortcuts";
import { focusedProject, useLayout } from "./lib/layout";
import { useLookHandover } from "./lib/mac-look";
import { useRouter, type Route } from "./lib/router";
import { useUi } from "./lib/ui";
import { useSpaceNavigation } from "./lib/space-navigation";
import { Memory } from "./views/Memory";
import { NewSubthread } from "./views/NewSubthread";
import { NewThread } from "./views/NewThread";
import { OrclingDesigner } from "./views/OrclingDesigner";
import { ProjectView } from "./views/ProjectView";
import { PullRequestList } from "./views/PullRequestList";
import { PullRequestView } from "./views/PullRequestView";
import { Scheduled } from "./views/Scheduled";
import { Settings } from "./views/Settings";
import { AgentUpdateNotice } from "./views/settings-agent-updates";
import { TaskListView } from "./views/TaskList";
import { TeamChatView } from "./views/TeamChatView";

// The diagnostics screen and its benchmark controls ship only in development and QA builds.
const Diagnostics = __OPENORC_QA__ ? lazy(() => import("./views/Diagnostics").then((m) => ({ default: m.Diagnostics }))) : null;
const NewTask = lazy(() => import("./views/NewTask").then((m) => ({ default: m.NewTask })));
const TaskView = lazy(() => import("./views/TaskView").then((m) => ({ default: m.TaskView })));

function projectForRoute(route: ReturnType<typeof useRouter.getState>["route"], savedProjectId: string | null): string | undefined {
  if (route.view === "project" || route.view === "newthread" || route.view === "newtask") return route.projectId;
  return savedProjectId ?? undefined;
}

/**
 * Navigation, a workspace of up to three conversations, and one shared panel.
 * Task screens keep their own panel; other screens use the main column alone.
 */
export function App() {
  const route = useRouter((state) => state.route);
  const projectId = useLayout(focusedProject);
  useLookHandover();
  useAppShortcuts(projectForRoute(route, projectId));
  return (
    <TooltipProvider>
      <OrganizationProvider>
        <AppOnboarding>
          <DesktopApp />
        </AppOnboarding>
      </OrganizationProvider>
    </TooltipProvider>
  );
}

function DesktopApp() {
  const space = useSpaceNavigation((state) => state.current);
  const personal = useSpaceNavigation((state) => state.personal);
  const home = space === null || space === personal ? "personal" : space;
  const route = useRouter((s) => s.route);
  const chatWork = useRouter((s) => s.chatWork);
  const workRoute = route.view === "team-chat" ? chatWork : route;
  const ui = useUi();
  const projectId = useLayout(focusedProject);
  const currentProject = projectForRoute(route, projectId);
  return (
    <div className="app-shell h-full flex text-ink">
      <Sidebar key={`sidebar:${home}`} />
      <div key={home} className="work-row flex-1 min-w-0 h-full flex" data-chat={route.view === "team-chat" || undefined}>
        {workRoute ? <StartScreen route={workRoute} /> : null}
        {workRoute?.view === "thread" ? <ThreadWorkspace /> : null}
        {route.view === "team-chat" ? <TeamChatView target={route} /> : null}
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

      <ThreadMoveDialog />
      <RemoveWorktreeDialog />
      <NewFileDialog />
    </div>
  );
}

/** The screens that start something: a thread, a thread under another, or a task. */
function StartScreen({ route }: { route: Route }) {
  if (route.view === "newthread")
    return (
      <OrganizationStart projectId={route.projectId}>
        <NewThread key={route.projectId ?? ""} projectId={route.projectId} />
      </OrganizationStart>
    );
  if (route.view === "newsubthread") return <NewSubthread key={route.parentId} parentId={route.parentId} />;
  if (route.view !== "newtask") return null;
  return (
    <Main>
      <Suspense fallback={<div className="document-skeleton" aria-label="Loading editor" />}>
        <NewTask key={`${route.projectId ?? ""}:${route.threadId ?? ""}`} projectId={route.projectId} threadId={route.threadId} />
      </Suspense>
    </Main>
  );
}

function MainScreen({ route, currentProject }: { route: Route; currentProject: string | undefined }) {
  const openNewTask = useUi((s) => s.openNewTask);
  const organization = useOrganization();
  let screen: ReactNode;
  switch (route.view) {
    case "people":
      screen =
        organization?.organization?.id === route.spaceId ? <OrganizationPeople key={route.spaceId} spaceId={route.spaceId} onInvite={organization.invite} onLeft={organization.refresh} /> : null;
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
      screen = <ProjectView projectId={route.projectId} />;
      break;
    case "memory":
      screen = <Memory />;
      break;
    case "scheduled":
      screen = <Scheduled />;
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

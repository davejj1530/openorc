import { useEffect, useRef, useState, type ReactNode } from "react";
import { WORKSPACE_ID, harnessIds, harnessInfo, harnessLoggedIn, type HarnessId, type Project, type TeamDetail, type WorkspaceMode } from "@openorc/protocol";
import { FolderGit2, GitBranch, Laptop } from "../components/icons";
import { Composer, ComposerChoice } from "../components/Composer";
import { Panel } from "../components/Panel";
import { useComposerChanges } from "../lib/composer-changes";
import { NewThreadMascot } from "../components/NewThreadMascot";
import { ArrivalPanel, useArrivalActivity } from "../components/NewThreadActivity";
import { ComposerModelPicker, defaultChoice, ModelPicker, type ModelChoice, type TeamPickerChoices } from "../components/ModelPicker";
import { TopBar } from "../components/TopBar";
import { Button, Kbd, Select, TextButton } from "../components/ui";
import { cn } from "../lib/cn";
import { teamMentionEntries } from "../lib/composer-mentions";
import { useLayout } from "../lib/layout";
import { readOnboardingState } from "../lib/onboarding";
import { evaluateNewThreadAvailability } from "../lib/new-thread-availability";
import { useNewThreadLocation } from "../lib/new-thread-location";
import { newThreadWorkspaceMode, readNewThreadDraft, readNewThreadProject, rememberNewThreadProject, targetModel, writeNewThreadDraft, type NewThreadDraft } from "../lib/new-thread-draft";
import { branchingReason, useProjectGit } from "../lib/project-git";
import { useRpc, useRpcMutation } from "../lib/query";
import { openThread, useRouter } from "../lib/router";
import { useSkillCommands } from "../lib/skill-commands";
import { useUi } from "../lib/ui";
import { usePermissionSelection } from "../lib/permission-default";
import { startNewThread } from "./new-thread-start";

const workspaceOptions = [
  {
    value: "current" as const,
    label: "Local checkout",
    hint: "The repository as it is checked out now",
    icon: Laptop,
  },
  {
    value: "worktree" as const,
    label: "Worktree",
    hint: "A branch and folder of its own, so other threads never collide with it",
    icon: GitBranch,
  },
];

/** Where the thread works: a folder of your choice in Workspace, the checkout or a worktree in a project. */
function ThreadPlace(props: { isWorkspace: boolean; mode: WorkspaceMode; blocked: string | null; disabled: boolean; onFolder: (folder: string) => void; onMode: (mode: WorkspaceMode) => void }) {
  const chooseFolder = async () => {
    const folder = await window.openorc.pickDirectory();
    if (folder) props.onFolder(folder);
  };
  if (!props.isWorkspace)
    return (
      <ComposerChoice
        ariaLabel="Where the thread works"
        value={props.mode}
        options={workspaceOptions}
        onChange={props.onMode}
        disabled={props.disabled || Boolean(props.blocked)}
        disabledReason={props.blocked ?? undefined}
      />
    );
  return (
    <Button variant="ghost" size="sm" disabled={props.disabled} title="Choose the folder for this conversation" onClick={() => void chooseFolder()}>
      Choose folder
    </Button>
  );
}

function heroHelp(input: { hasProject: boolean; activity: ReturnType<typeof useArrivalActivity>; revision: boolean; isWorkspace: boolean }): ReactNode {
  if (!input.hasProject) return null;
  if (input.activity.any) return <ArrivalPanel activity={input.activity} />;
  return (
    <ul className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-4">
      {!input.isWorkspace ? (
        <li className="flex items-center gap-1.5">
          <Kbd>@</Kbd>
          {input.revision ? "address a member" : "mention a file"}
        </li>
      ) : null}
      <li className="flex items-center gap-1.5">
        <Kbd>⌘V</Kbd>paste an image
      </li>
      <li className="flex items-center gap-1.5">
        <Kbd>⌘K</Kbd>search
      </li>
    </ul>
  );
}

/** Project changes remount the composer so prompt, target and image drafts move together. */
export function NewThread({ projectId }: { projectId?: string }) {
  const projects = useRpc("projects.list", {});
  const home = useRpc("workspace.get", {});
  const railProject = useLayout((s) => s.projectId);
  const [preferredHarness] = useState<HarnessId | null>(() => readOnboardingState().defaultHarness);
  const [project, setProject] = useState(() => projectId ?? railProject ?? readNewThreadProject() ?? WORKSPACE_ID);
  const chooseProject = (id: string) => {
    rememberNewThreadProject(id);
    setProject(id);
  };
  useEffect(() => {
    if (projectId) chooseProject(projectId);
  }, [projectId]);
  useEffect(() => {
    if (!project && projects.data?.[0]) chooseProject(railProject ?? projects.data[0].id);
  }, [project, projects.data, railProject]);
  return (
    <NewThreadProject
      key={project}
      projectId={project}
      projects={home.data ? [home.data, ...(projects.data ?? [])] : projects.data}
      projectsError={projects.error?.message}
      onProject={chooseProject}
      onRetryProjects={() => void projects.refetch()}
      preferredHarness={preferredHarness}
    />
  );
}

function NewThreadProject({
  projectId,
  projects,
  projectsError,
  onProject,
  onRetryProjects,
  preferredHarness,
}: {
  projectId: string;
  projects: Project[] | undefined;
  projectsError?: string;
  onProject: (id: string) => void;
  onRetryProjects: () => void;
  preferredHarness: HarnessId | null;
}) {
  const isWorkspace = projectId === WORKSPACE_ID;
  const git = useProjectGit(projectId);
  const info = useRpc("system.info", {});
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const settings = useRpc("app.settings.get", {});
  const teams = useRpc("orchestration.list", { projectId, includeArchived: true }, { enabled: Boolean(projectId) });
  const availability = useRpc("orchestration.availability", {});
  const activity = useArrivalActivity();
  const [draft, setDraft] = useState(() => readNewThreadDraft(projectId));
  const [storageError, setStorageError] = useState<string | null>(null);
  const { permission, select: setPermission, error: permissionError, ready: permissionReady } = usePermissionSelection();
  const start = useRpcMutation("threads.start");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const changeDraft = (patch: Partial<NewThreadDraft>) => {
    const next = { ...draft, ...patch };
    setStorageError(writeNewThreadDraft(next) ? null : "This draft could not be saved on your device. Keep this task open while you work.");
    setDraft(next);
    start.reset();
  };
  const choice = targetModel(draft.target);
  const target = draft.target;
  const revision = target.kind === "team" ? target.revision : null;
  const lead = revision?.members.find((member) => member.managerKey === null);
  // The landing composer has no thread, so no thread action applies to it. The
  // skills do: they belong to the project, which is chosen on this screen.
  const skillCommands = useSkillCommands(isWorkspace ? undefined : projectId, choice?.agent);
  const workspaceMode = newThreadWorkspaceMode({ canBranch: !isWorkspace && !git.cannotBranch, chosen: draft.workspace, preferred: settings.data?.defaultWorkspaceMode });

  useEffect(() => {
    if (target.kind !== "model" || target.choice || !models.data || !info.data) return;
    const initial = defaultChoice(models.data, [...(preferredHarness ? [preferredHarness] : []), ...harnessIds].find((id) => harnessLoggedIn(harnessInfo(info.data, id))) ?? null);
    if (initial) changeDraft({ target: { kind: "model", choice: initial } });
  }, [target, models.data, info.data, preferredHarness]);

  const {
    selectedProject: selected,
    selectedTeam,
    targetIssue,
    projectIssue,
    disabledReason,
    teamOptions,
    teamStatus,
  } = evaluateNewThreadAvailability({
    projectId,
    projects,
    teamBlocker: branchingReason(git.state, "Teams"),
    projectsFailed: Boolean(projectsError),
    permissionReady,
    target,
    choice,
    teams: { data: teams.data, failed: teams.isError, pending: teams.isPending },
    availability: { data: availability.data, failed: availability.isError },
    models: { data: models.data, failed: models.isError },
    system: { data: info.data, failed: info.isError },
  });
  const location = useNewThreadLocation(projectId, selected, workspaceMode, draft.workingDirectory);
  const chooseTeam = (detail: TeamDetail) =>
    changeDraft({
      target: {
        kind: "team",
        revision: detail.revision,
        initialLeadOverrides: {},
      },
    });
  const chooseModel = (model: ModelChoice) => changeDraft({ target: { kind: "model", choice: model } });
  const changeSettings = (model: ModelChoice) => {
    if (target.kind === "team")
      changeDraft({
        target: {
          ...target,
          initialLeadOverrides: {
            effort: model.effort,
            fastMode: Boolean(model.fastMode),
          },
        },
      });
    else chooseModel(model);
  };
  const retry = () => {
    void teams.refetch();
    void availability.refetch();
    void models.refetch();
    void info.refetch();
    onRetryProjects();
  };
  let selectedTeamFields: { selectedRevisionId?: string; selectedLabel?: string } = {};
  if (revision) selectedTeamFields = { selectedRevisionId: revision.id, selectedLabel: revision.name };
  else if (target.kind === "unavailable") selectedTeamFields = { selectedLabel: target.label };
  let teamAction: TeamPickerChoices["action"];
  if (teams.isError || availability.isError) teamAction = { label: "Retry team checks", onSelect: retry };
  else if (availability.data && !availability.data.enabled) teamAction = { label: "Open Settings", onSelect: () => useRouter.getState().navigate({ view: "settings" }) };
  else if (teams.data && !teams.data.some((team) => team.team.archivedAt === null))
    teamAction = { label: "Create a team in Orchestration", onSelect: () => useRouter.getState().navigate({ view: "orchestration", projectId }) };
  const pickerTeams: TeamPickerChoices = {
    options: teamOptions,
    ...selectedTeamFields,
    onSelect: (id) => {
      const team = teams.data?.find((detail) => detail.revision.id === id);
      if (team) chooseTeam(team);
    },
    status: teamStatus,
    ...(teamAction ? { action: teamAction } : {}),
  };

  const submit = async (text: string, attachments: string[]) => {
    if (disabledReason) throw new Error(disabledReason);
    if (!choice || !selected || target.kind === "unavailable") throw new Error("Choose a project and execution target first.");
    const threadId = await startNewThread({
      draft,
      project: selected,
      isWorkspace,
      workspaceMode,
      permissionMode: permission,
      text,
      attachments,
      launch: (params) => start.mutateAsync(params),
      onPendingDraft: setDraft,
    });
    if (mounted.current && useRouter.getState().route.view === "newthread") openThread(threadId);
  };

  const composerChanges = useComposerChanges(git.tracks && selected && workspaceMode === "current" ? { kind: "project", id: selected.id, projectName: selected.name } : null);
  const panelContext = selected
    ? { kind: "newthread" as const, project: selected, workingDirectory: draft.workingDirectory ?? selected.rootPath, changes: git.tracks && workspaceMode === "current" }
    : null;

  return (
    <>
      <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
        <TopBar projectId={projectId} projectName={selected?.name} onProjectChange={(id) => onProject(id ?? WORKSPACE_ID)} panel={Boolean(panelContext)}>
          New thread
        </TopBar>
        <div className="new-thread-body flex-1 min-h-0 flex flex-col overflow-y-auto">
          <div className={cn("flex-1 flex justify-center pt-8", activity.any ? "items-start pb-8" : "items-end pb-hero")}>
            <div className="relative max-w-chat w-full px-6">
              <NewThreadMascot choice={choice} placement="hero" />
              <h1 className="text-xl font-medium text-ink mb-2">What should we work on?</h1>
              <p className="text-base text-ink-3 max-w-md">
                {isWorkspace
                  ? "Start a conversation in any folder. Slack conversations live here too."
                  : "The agent works in your project folder. You may create a task first or go straight into building."}
              </p>
              {heroHelp({ hasProject: projects?.length !== 0, activity, revision: Boolean(revision), isWorkspace })}
            </div>
          </div>
          <div className="new-thread-composer shrink-0 w-full max-w-chat mx-auto px-6 pb-2">
            {projects?.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface p-4 text-base text-ink-2">
                Import a project to start.
                <div className="mt-3">
                  <Button variant="primary" size="sm" onClick={() => useUi.getState().setImportProject(true)}>
                    <FolderGit2 size={13} /> Import project
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Composer
                    draftKey={`newthread.${projectId}.attachments`}
                    autoFocus
                    value={draft.prompt}
                    onChange={(prompt) => changeDraft({ prompt })}
                    onSubmit={submit}
                    placeholder={revision ? "Message the team… (@name to address a member)" : "What would you like to do?"}
                    size="lg"
                    {...(revision ? { mentions: teamMentionEntries(revision) } : {})}
                    model={choice}
                    onModel={changeSettings}
                    modelControl={
                      target.kind === "unavailable" ? (
                        <ModelPicker value={null} onChange={chooseModel} teams={isWorkspace ? undefined : pickerTeams} disabled={start.isPending} />
                      ) : (
                        <ComposerModelPicker
                          value={choice}
                          onChange={changeSettings}
                          onSelectModel={chooseModel}
                          teams={isWorkspace ? undefined : pickerTeams}
                          disabled={start.isPending}
                          {...(revision && lead
                            ? {
                                team: {
                                  name: revision.name,
                                  revision: revision.number,
                                  leadName: lead.name,
                                },
                              }
                            : {})}
                        />
                      )
                    }
                    mode={draft.mode}
                    onMode={(mode) => changeDraft({ mode })}
                    permission={permission}
                    onPermission={setPermission}
                    settingsDisabled={start.isPending}
                    location={location}
                    changes={composerChanges}
                    projectId={isWorkspace ? undefined : projectId || undefined}
                    commands={skillCommands}
                    busy={start.isPending}
                    disabledReason={disabledReason}
                    error={start.error?.message ?? permissionError ?? storageError}
                    projectControl={
                      !selected && projects?.length ? (
                        <Select
                          aria-label="New thread project"
                          value={projectId}
                          disabled={start.isPending}
                          onChange={(event) => onProject(event.target.value)}
                          className="h-6 text-base max-w-48 border-0 bg-transparent hover:bg-surface-2"
                        >
                          {!selected ? <option value={projectId}>Unavailable project</option> : null}
                          {(projects ?? []).map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </Select>
                      ) : null
                    }
                  >
                    <ThreadPlace
                      isWorkspace={isWorkspace}
                      mode={workspaceMode}
                      blocked={branchingReason(git.state, "Worktrees")}
                      disabled={start.isPending}
                      onFolder={(workingDirectory) => changeDraft({ workingDirectory })}
                      onMode={(workspace) => changeDraft({ workspace })}
                    />
                  </Composer>
                </div>
                {targetIssue || projectIssue ? (
                  <p role="status" className="text-xs text-warn mt-2 break-words">
                    {targetIssue ?? projectIssue}{" "}
                    <TextButton type="button" underline tone="strong" onClick={retry}>
                      Retry checks
                    </TextButton>
                    {revision ? (
                      <>
                        {" "}
                        <TextButton
                          type="button"
                          underline
                          tone="strong"
                          onClick={() =>
                            useRouter.getState().navigate({
                              view: "orchestration",
                              projectId,
                              teamId: revision.teamId,
                            })
                          }
                        >
                          Open team
                        </TextButton>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {revision && selectedTeam && selectedTeam.revision.id !== revision.id ? (
                  <p className="text-xs text-ink-3 mt-2">
                    Revision {revision.number} is selected.{" "}
                    <TextButton type="button" underline tone="strong" disabled={start.isPending} onClick={() => chooseTeam(selectedTeam)}>
                      Use revision {selectedTeam.revision.number}
                    </TextButton>
                  </p>
                ) : null}
              </>
            )}
            <div className="h-4" />
            {/* <p className="text-xs text-ink-3 mt-3 text-center">{revision ? "Each agent uses an isolated workspace. You direct the lead, which delegates to the team." : draft.mode === "plan" ? "Plan investigates first. Tasks save to backlog." : "Tasks save to backlog. Ask to start them when you’re ready."}</p> */}
          </div>
        </div>
      </main>
      {panelContext ? <Panel context={panelContext} /> : null}
    </>
  );
}

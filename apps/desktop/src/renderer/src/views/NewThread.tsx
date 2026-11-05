import { newThreadChoice, newThreadWorkspaceMode, targetModel, type CloudTurnWho, type ModelChoice as Choice, type NewThreadDraft, type NewThreadPlace } from "@openorc/client";
import { WORKSPACE_ID, type Project } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { ClaudeAccountPicker } from "../components/ClaudeAccountPicker";
import { useCloudSignInGate } from "../components/CloudSignInOffer";
import { Composer } from "../components/Composer";
import { FolderGit2 } from "../components/icons";
import { ComposerModelPicker, ModelPicker, type ModelChoice, type OrclingPickerChoices } from "../components/ModelPicker";
import { NewThreadRecent, useArrivalActivity } from "../components/NewThreadActivity";
import { NewThreadProjectChoice } from "../components/NewThreadContext";
import { NewThreadOptions } from "../components/NewThreadOptions";
import { NewThreadStarters } from "../components/NewThreadStarters";
import { Panel } from "../components/Panel";
import { TopBar } from "../components/TopBar";
import { Button, TextButton } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { usePermissionSelection, useRpc, useRpcMutation } from "../lib/client";
import { useNewThreadCloud, type NewThreadCloud } from "../lib/cloud-offered";
import { useComposerChanges } from "../lib/composer-changes";
import { useDefaultHarness } from "../lib/default-harness";
import { useLayout } from "../lib/layout";
import { evaluateNewThreadAvailability } from "../lib/new-thread-availability";
import { readNewThreadDraft, readNewThreadProject, rememberNewThreadProject, writeNewThreadDraft } from "../lib/new-thread-draft";
import { useNewThreadLocation } from "../lib/new-thread-location";
import { orclingById, useOrclings } from "../lib/orclings";
import { branchingReason, useProjectGit } from "../lib/project-git";
import { openThread, useRouter } from "../lib/router";
import { useSkillCommands } from "../lib/skill-commands";
import { useUi } from "../lib/ui";
import { startNewThread } from "./new-thread-start";

/** Project changes remount the composer so prompt, target and image drafts move together. */
export function NewThread({ projectId }: { projectId?: string }) {
  const projects = useRpc("projects.list", {});
  const home = useRpc("workspace.get", {});
  const railProject = useLayout((s) => s.projectId);
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
    />
  );
}

/** Who a new cloud thread's first turn signs in as; null for one that starts on this Mac. */
function newCloudTurn(mode: NewThreadPlace, choice: Choice | null, claudeAccountId: string, cloud: NewThreadCloud): CloudTurnWho | null {
  return mode === "cloud" && choice ? { agent: choice.agent, claudeAccountId, model: choice.model, brain: cloud.brain, local: cloud.local } : null;
}

/** The Orclings the model picker offers, the one chosen marked. */
function orclingChoices(options: OrclingPickerChoices["options"], target: NewThreadDraft["target"], choose: (target: NewThreadDraft["target"]) => void): OrclingPickerChoices {
  return {
    options,
    selectedId: target.kind === "orcling" ? target.orclingId : null,
    onSelect: (orcling) => choose({ kind: "orcling", orclingId: orcling.id, name: orcling.name, settings: orcling.settings }),
  };
}

function NewThreadProject({
  projectId,
  projects,
  projectsError,
  onProject,
  onRetryProjects,
}: {
  projectId: string;
  projects: Project[] | undefined;
  projectsError?: string;
  onProject: (id: string) => void;
  onRetryProjects: () => void;
}) {
  const isWorkspace = projectId === WORKSPACE_ID;
  const git = useProjectGit(projectId);
  const [draft, setDraft] = useState(() => readNewThreadDraft(projectId));
  const accounts = useRpc("claude.accounts.list", {});
  const orclings = useOrclings();
  // An Orcling runs on its own account; the account chosen here is for models.
  const orcling = orclingById(orclings, draft.target.kind === "orcling" ? draft.target.orclingId : null);
  const claudeAccountId = orcling?.claudeAccountId ?? draft.claudeAccountId ?? accounts.data?.defaultId ?? "claude-cli";
  const info = useRpc("system.info", { claudeAccountId });
  const models = useRpc("agents.models", { claudeAccountId }, { staleTime: 5 * 60_000 });
  const settings = useRpc("app.settings.get", {});
  const defaultHarness = useDefaultHarness();
  const activity = useArrivalActivity();
  const [storageError, setStorageError] = useState<string | null>(null);
  const { permission, select: setPermission, error: permissionError, ready: permissionReady } = usePermissionSelection();
  const start = useRpcMutation("threads.start");
  const mounted = useRef(true);
  const composer = useRef<HTMLDivElement>(null);
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
  // The landing composer has no thread, so no thread action applies to it. The
  // skills do: they belong to the project, or the Workspace folder, chosen on this screen.
  const skillCommands = useSkillCommands(projectId, choice?.agent, draft.workingDirectory, claudeAccountId);
  const cloud = useNewThreadCloud(target, projectId);
  const workspaceMode = newThreadWorkspaceMode({ canBranch: !isWorkspace && !git.cannotBranch, canCloud: cloud.can, chosen: draft.workspace, preferred: settings.data?.defaultWorkspaceMode });
  const signIn = useCloudSignInGate(newCloudTurn(workspaceMode, choice, claudeAccountId, cloud));

  useEffect(() => {
    if (target.kind !== "model" || target.choice || !models.data || !info.data || defaultHarness === undefined) return;
    const initial = newThreadChoice(models.data, { preferred: defaultHarness, harnesses: info.data.harnesses });
    if (initial) changeDraft({ target: { kind: "model", choice: initial } });
  }, [target, models.data, info.data, defaultHarness]);

  const {
    selectedProject: selected,
    targetIssue,
    projectIssue,
    disabledReason: targetDisabledReason,
  } = evaluateNewThreadAvailability({
    projectId,
    projects,
    projectsFailed: Boolean(projectsError),
    permissionReady,
    target,
    choice,
    models: { data: models.data, failed: models.isError },
    system: { data: info.data, failed: info.isError },
  });
  const usesClaude = choice?.agent === "claude";
  const disabledReason = usesClaude && !accounts.data ? (accounts.error?.message ?? "Loading Claude accounts…") : targetDisabledReason;
  const location = useNewThreadLocation(projectId, selected, workspaceMode, draft.workingDirectory);
  const chooseModel = (model: ModelChoice) => changeDraft({ target: { kind: "model", choice: model } });
  const changeSettings = chooseModel;
  const retry = () => {
    void accounts.refetch();
    void models.refetch();
    void info.refetch();
    onRetryProjects();
  };
  const pickerOrclings = orclingChoices(orclings, target, (next) => changeDraft({ target: next }));

  const submit = async (text: string, attachments: string[]) => {
    if (disabledReason) throw new Error(disabledReason);
    if (!choice || !selected || target.kind === "unavailable") throw new Error("Choose a project and execution target first.");
    const threadId = await startNewThread({
      draft: { ...draft, claudeAccountId },
      project: selected,
      isWorkspace,
      workspaceMode,
      permissionMode: permission,
      text,
      attachments,
      // A cloud start waits for the sign-in the cloud lacks, offered above the composer.
      launch: (params) => signIn.ready().then(() => start.mutateAsync(params)),
    });
    if (mounted.current && useRouter.getState().route.view === "newthread") openThread(threadId);
  };

  const composerChanges = useComposerChanges(git.tracks && selected && workspaceMode === "current" ? { kind: "project", id: selected.id, projectName: selected.name } : null);
  const panelContext = selected
    ? { kind: "newthread" as const, project: selected, workingDirectory: draft.workingDirectory ?? selected.rootPath, changes: git.tracks && workspaceMode === "current" }
    : null;

  return (
    <ClaudeAccountScope id={claudeAccountId}>
      <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
        <TopBar showProject={false} panel={Boolean(panelContext)}>
          {null}
        </TopBar>
        <div className="new-thread-body flex-1 min-h-0 overflow-y-auto">
          <div ref={composer} className="new-thread-column">
            {projects?.length === 0 ? (
              <div className="new-thread-empty">
                Import a project to start.
                <div className="mt-3">
                  <Button variant="primary" size="sm" onClick={() => useUi.getState().setImportProject(true)}>
                    <FolderGit2 size={13} /> Import project
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="new-thread-question">{selected && !isWorkspace ? `What should we work on in ${selected.name}?` : "What should we work on?"}</h1>
                <div className="relative">
                  <div className="mb-2 empty:hidden">{signIn.offer}</div>
                  <Composer
                    draftKey={`newthread.${projectId}.attachments`}
                    autoFocus
                    value={draft.prompt}
                    onChange={(prompt) => changeDraft({ prompt })}
                    onSubmit={submit}
                    placeholder="Ask OpenOrc to build, fix bugs, explore"
                    size="lg"
                    presentation="new-thread"
                    projectControl={<NewThreadProjectChoice projectId={projectId} projects={projects} disabled={start.isPending} onProject={onProject} />}
                    model={choice}
                    onModel={changeSettings}
                    modelControl={
                      target.kind === "unavailable" ? (
                        <ModelPicker value={null} onChange={chooseModel} orclings={isWorkspace ? undefined : pickerOrclings} disabled={start.isPending} />
                      ) : (
                        <ComposerModelPicker value={choice} onChange={changeSettings} onSelectModel={chooseModel} orclings={isWorkspace ? undefined : pickerOrclings} disabled={start.isPending} />
                      )
                    }
                    mode={draft.mode}
                    onMode={(mode) => changeDraft({ mode })}
                    permission={permission}
                    onPermission={setPermission}
                    settingsDisabled={start.isPending}
                    location={location}
                    fileSearch={isWorkspace || !projectId ? undefined : { kind: "project", id: projectId }}
                    commands={skillCommands}
                    busy={start.isPending}
                    disabledReason={disabledReason}
                    error={start.error?.message ?? permissionError ?? storageError}
                  />
                </div>
                <NewThreadOptions
                  projectId={projectId}
                  mode={workspaceMode}
                  cloud={cloud}
                  location={location}
                  blocked={branchingReason(git.state, "Worktrees")}
                  disabled={start.isPending}
                  onFolder={(workingDirectory) => changeDraft({ workingDirectory })}
                  onMode={(workspace) => changeDraft({ workspace })}
                  changes={composerChanges}
                  account={
                    usesClaude && !orcling ? (
                      <ClaudeAccountPicker compact accounts={accounts.data} value={claudeAccountId} onChange={(claudeAccountId) => changeDraft({ claudeAccountId })} disabled={start.isPending} />
                    ) : null
                  }
                />
                {targetIssue || projectIssue ? (
                  <p role="status" className="text-xs text-warn mt-2 break-words">
                    {targetIssue ?? projectIssue}{" "}
                    <TextButton type="button" underline tone="strong" onClick={retry}>
                      Retry checks
                    </TextButton>
                  </p>
                ) : null}
              </>
            )}
            {selected && !isWorkspace && !draft.prompt.trim() ? (
              <NewThreadStarters
                disabled={start.isPending}
                onStart={(prompt) => {
                  changeDraft({ prompt, mode: "plan" });
                  composer.current?.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
                }}
              />
            ) : null}
            {activity.any ? <NewThreadRecent activity={activity} /> : null}
          </div>
        </div>
      </main>
      {panelContext ? <Panel context={panelContext} /> : null}
    </ClaudeAccountScope>
  );
}

import { useSpaceProjects } from "../lib/space-queries";
import { newThreadWorkspaceMode, offeredAccount, projectAccountChoice, targetModel, type CloudTurnWho, type ModelChoice as Choice, type NewThreadDraft, type NewThreadPlace } from "@openorc/client";
import { WORKSPACE_ID, executionMode, type ClaudeAccounts, type Project } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { useCloudSignInGate } from "../components/CloudSignInOffer";
import { Composer } from "../components/Composer";
import { ComposerCommitChip } from "../components/ComposerCommitChip";
import { FolderPlus } from "../components/icons";
import { type PickerAccounts } from "../components/ModelPickerAccounts";
import { ComposerModelPicker, ModelPicker, type ModelChoice, type OrclingPickerChoices } from "../components/ModelPicker";
import { NewThreadOptions } from "../components/NewThreadOptions";
import { loadProjectActivity, ProjectActivity } from "../components/ProjectActivity";
import { Panel } from "../components/Panel";
import { NewThreadQuestion } from "../components/ProjectPicker";
import { DitherBackdrop } from "../components/DitherBackdrop";
import { ThreadTabs } from "../components/ThreadTabs";
import { TopBar } from "../components/TopBar";
import { Button, TextButton } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { usePermissionSelection, useRpc, useRpcMutation } from "../lib/client";
import { useNewThreadCloud, useNewThreadHosted, type NewThreadCloud } from "../lib/cloud-offered";
import { useCloudWarm } from "../lib/cloud-warm";
import { usePublishComposerAccount } from "../lib/composer-account";
import { useComposerChanges } from "../lib/composer-changes";
import { useDefaultHarness } from "../lib/default-harness";
import { focusedProject, useLayout } from "../lib/layout";
import { swapInPlace } from "../lib/motion";
import { evaluateNewThreadAvailability, initialThreadChoice } from "../lib/new-thread-availability";
import { readNewThreadDraft, readNewThreadProject, rememberNewThreadProject, writeNewThreadDraft } from "../lib/new-thread-draft";
import { useNewThreadLocation } from "../lib/new-thread-location";
import { useNewThreadPreparation } from "../lib/new-thread-preparation";
import { useNewThreadFiles } from "../lib/new-thread-files";
import { orclingById, useOrclings } from "../lib/orclings";
import { branchingReason, loadProjectGit, useProjectGit } from "../lib/project-git";
import { openThread, useRouter } from "../lib/router";
import { useComposerSuggestions } from "../lib/connector-mentions";
import { projectScope } from "../lib/skill-commands";
import { useUi } from "../lib/ui";
import { startNewThread } from "./new-thread-start";
import { startSpaceThread } from "../lib/space-start";
import { spaceNavigation, useSpaceNavigation } from "../lib/space-navigation";

/** How long a project switch waits for the reads that size the screen before it swaps without them. */
const SWITCH_READS_MS = 250;

/** Project changes remount the composer so prompt, target and image drafts move together. */
export function NewThread({ projectId }: { projectId?: string }) {
  const personal = useSpaceNavigation((state) => !state.current || state.current === state.personal);
  const projects = useSpaceProjects(false, true);
  const home = useRpc("workspace.get", {});
  // The project the screen was opened for, else the one the sidebar's filter focuses, else the last one chosen here.
  const focused = useLayout(focusedProject);
  const wanted = projectId ?? focused;
  const [project, setProject] = useState(() => wanted ?? readNewThreadProject() ?? WORKSPACE_ID);
  const chooseProject = (id: string) => {
    rememberNewThreadProject(id);
    setProject(id);
  };
  useEffect(() => {
    if (wanted) chooseProject(wanted);
  }, [wanted]);
  // Moving the sidebar's filter while the screen shows moves the question to that project too.
  const filtered = useRef(focused);
  useEffect(() => {
    if (focused === filtered.current) return;
    filtered.current = focused;
    if (focused) chooseProject(focused);
  }, [focused]);
  // A remembered project that has since been removed gives way to Workspace.
  useEffect(() => {
    if (projects.data && !(personal && project === WORKSPACE_ID) && !projects.data.some((each) => each.id === project)) chooseProject(personal ? WORKSPACE_ID : (projects.data[0]?.id ?? ""));
  }, [project, projects.data, personal]);
  // Choosing a project in the question brings a focused sidebar filter along. The screen swaps in place once the
  // project's git state and activity are read, so the Commit chip, location and activity never blink out and back.
  const switching = useRef(0);
  useEffect(() => () => void switching.current++, []);
  const switchProject = (id: string) => {
    const turn = ++switching.current;
    const local = projects.data?.some((project) => project.id === id && !project.rootPath) !== true;
    const reads = local ? Promise.all([loadProjectGit(id), loadProjectActivity(id)]) : Promise.resolve();
    void Promise.race([reads, new Promise((resolve) => setTimeout(resolve, SWITCH_READS_MS))])
      .catch(() => undefined)
      .then(() => {
        if (turn !== switching.current) return;
        swapInPlace("project", () => {
          useLayout.getState().followProject(id);
          chooseProject(id);
        });
      });
  };
  return (
    <NewThreadProject
      key={project}
      projectId={project}
      projects={personal && home.data ? [home.data, ...(projects.data ?? [])] : projects.data}
      projectsError={projects.error?.message}
      onProject={switchProject}
      onRetryProjects={() => void projects.refetch()}
    />
  );
}

/**
 * The Claude accounts a new thread in the project can choose, the app's or the project's own, and the one it starts on:
 * an Orcling's own, else the draft's while the project uses it, else the project's default.
 */
function useNewThreadAccount(projects: Project[] | undefined, projectId: string, drafted: string | undefined, orcling: string | undefined) {
  const list = useRpc("claude.accounts.list", {});
  const project = projects?.find((each) => each.id === projectId);
  const choice = list.data ? projectAccountChoice(project, list.data) : undefined;
  const choices: ClaudeAccounts | undefined = choice && { accounts: choice.accounts, defaultId: choice.defaultId };
  return { list, choices, claudeAccountId: orcling ?? offeredAccount(choice, drafted) ?? choice?.defaultId ?? "claude-cli" };
}

/** A new thread's Claude accounts for its model picker: the ones its project uses, the chosen one checked. An Orcling brings its own. */
function newThreadAccounts(choices: ClaudeAccounts | undefined, current: string, starting: boolean, choose: (id: string) => void): PickerAccounts | undefined {
  return choices ? { accounts: choices.accounts, current, choose, blocked: starting ? "Starting the thread…" : undefined } : undefined;
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
  const spaceId = useSpaceNavigation((state) => state.current);
  const cloudOnly = Boolean(spaceId && projects?.some((project) => project.id === projectId && !project.rootPath));
  const isWorkspace = projectId === WORKSPACE_ID;
  const git = useProjectGit(cloudOnly ? null : projectId);
  const [draft, setDraft] = useState(() => readNewThreadDraft(projectId));
  useNewThreadPreparation(projectId, draft.prompt);
  const orclings = useOrclings();
  // An Orcling runs on its own account; the account chosen here is for models.
  const orcling = orclingById(orclings, draft.target.kind === "orcling" ? draft.target.orclingId : null);
  const { list: accounts, choices: accountChoices, claudeAccountId } = useNewThreadAccount(projects, projectId, draft.claudeAccountId, orcling?.claudeAccountId);
  const info = useRpc("system.info", { claudeAccountId });
  const models = useRpc("agents.models", { claudeAccountId }, { staleTime: 5 * 60_000 });
  const settings = useRpc("app.settings.get", {});
  const defaultHarness = useDefaultHarness();
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
  // The landing composer has no thread, so no thread action applies to it. The
  // skills do: they belong to the project, or the Workspace folder, chosen on this screen.
  const suggestions = useComposerSuggestions(projectScope(projectId, draft.workingDirectory), choice?.agent, executionMode(draft.mode, permission), claudeAccountId);
  const cloud = useNewThreadCloud(target, projectId);
  const hosted = useNewThreadHosted(target, projectId);
  const workspaceMode = cloudOnly
    ? "hosted"
    : newThreadWorkspaceMode({
        canBranch: !isWorkspace && !git.cannotBranch,
        canCloud: cloud.can,
        canHosted: hosted.can,
        chosen: draft.workspace,
        preferred: settings.data?.defaultWorkspaceMode,
      });
  const signIn = useCloudSignInGate(newCloudTurn(workspaceMode, choice, claudeAccountId, cloud));
  const files = useNewThreadFiles(projectId, workspaceMode === "hosted");
  useCloudWarm(workspaceMode === "cloud" && cloud.can ? projectId : null, choice?.agent, draft.prompt);

  useEffect(() => {
    if (target.kind !== "model" || target.choice || !models.data || defaultHarness === undefined) return;
    const initial = initialThreadChoice(models.data, defaultHarness, info.data, cloudOnly);
    if (initial) changeDraft({ target: { kind: "model", choice: initial } });
  }, [target, models.data, info.data, defaultHarness, cloudOnly]);
  usePublishComposerAccount(choice?.agent, claudeAccountId, choice?.model);

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
    hosted: cloudOnly,
    target,
    choice,
    models: { data: models.data, failed: models.isError },
    system: { data: info.data, failed: info.isError },
  });
  const usesClaude = choice?.agent === "claude";
  const pickerAccounts = orcling || cloudOnly ? undefined : newThreadAccounts(accountChoices, claudeAccountId, start.isPending, (id) => changeDraft({ claudeAccountId: id }));
  const localReason = usesClaude && !accounts.data ? (accounts.error?.message ?? "Loading Claude accounts…") : targetDisabledReason;
  const disabledReason = cloudOnly ? (hosted.blocked?.words ?? (!hosted.shown ? "Checking OpenOrc Cloud…" : targetDisabledReason)) : localReason;
  const location = useNewThreadLocation(projectId, selected, workspaceMode, draft.workingDirectory);
  const chooseModel = (model: ModelChoice) => changeDraft({ target: { kind: "model", choice: model } });
  const retry = () => {
    void accounts.refetch();
    void models.refetch();
    void info.refetch();
    onRetryProjects();
  };
  const pickerOrclings = isWorkspace || cloudOnly ? undefined : orclingChoices(orclings, target, (next) => changeDraft({ target: next }));

  const submit = async (text: string, attachments: string[]) => {
    const { generation, key } = spaceNavigation.getState();
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
      files,
      // A cloud start waits for the sign-in the cloud lacks, offered above the composer.
      launch: (params) => signIn.ready().then(() => startSpaceThread(params, start.mutateAsync, spaceId, key)),
    });
    if (mounted.current && spaceNavigation.getState().generation === generation && useRouter.getState().route.view === "newthread") openThread(threadId);
  };

  const composerChanges = useComposerChanges(git.tracks && selected && workspaceMode === "current" ? { kind: "project", id: selected.id, projectName: selected.name } : null);
  const panelContext =
    selected && !cloudOnly
      ? { kind: "newthread" as const, project: selected, workingDirectory: draft.workingDirectory ?? selected.rootPath, changes: git.tracks && workspaceMode === "current" }
      : null;

  return (
    <ClaudeAccountScope id={claudeAccountId}>
      <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
        <TopBar tabs panel={Boolean(panelContext)}>
          <ThreadTabs />
        </TopBar>
        <div className="new-thread-body flex-1 min-h-0 overflow-y-auto">
          <DitherBackdrop />
          <div className="new-thread-column">
            {projects?.length === 0 ? (
              <div className="new-thread-empty">
                Add a project to start.
                <div className="mt-3">
                  <Button variant="primary" size="sm" onClick={() => useUi.getState().setImportProject(true)}>
                    <FolderPlus size={13} /> Add project
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <NewThreadQuestion projectId={projectId} projects={projects} disabled={start.isPending} onProject={onProject} />
                <div className="relative">
                  <div className="new-thread-changes empty:hidden">
                    <ComposerCommitChip changes={composerChanges} />
                  </div>
                  <Composer
                    draftKey={files.draftKey}
                    hostedFiles={files.hostedFiles}
                    autoFocus
                    value={draft.prompt}
                    onChange={(prompt) => changeDraft({ prompt })}
                    onSubmit={submit}
                    placeholder="Ask OpenOrc to build, fix bugs, explore"
                    size="lg"
                    presentation="new-thread"
                    notices={signIn.offer}
                    model={choice}
                    onModel={chooseModel}
                    modelControl={
                      target.kind === "unavailable" ? (
                        <ModelPicker value={null} onChange={chooseModel} orclings={pickerOrclings} disabled={start.isPending} />
                      ) : (
                        <ComposerModelPicker value={choice} onChange={chooseModel} onSelectModel={chooseModel} orclings={pickerOrclings} accounts={pickerAccounts} disabled={start.isPending} />
                      )
                    }
                    mode={draft.mode}
                    onMode={(mode) => changeDraft({ mode })}
                    permission={permission}
                    onPermission={setPermission}
                    settingsDisabled={start.isPending}
                    location={location}
                    fileSearch={isWorkspace || !projectId ? undefined : { kind: "project", id: projectId }}
                    {...suggestions}
                    busy={start.isPending}
                    disabledReason={disabledReason}
                    error={start.error?.message ?? permissionError ?? storageError}
                  >
                    <NewThreadOptions
                      local={!cloudOnly}
                      projectId={projectId}
                      mode={workspaceMode}
                      cloud={cloud}
                      hosted={hosted}
                      location={location}
                      blocked={branchingReason(git.state, "Worktrees")}
                      disabled={start.isPending}
                      onFolder={(workingDirectory) => changeDraft({ workingDirectory })}
                      onMode={(workspace) => changeDraft({ workspace })}
                    />
                  </Composer>
                </div>
                <NewThreadIssue issue={targetIssue ?? projectIssue} retry={retry} />
              </>
            )}
          </div>
          {cloudOnly ? null : <ProjectActivity projectId={projectId} />}
        </div>
      </main>
      {panelContext ? <Panel context={panelContext} /> : null}
    </ClaudeAccountScope>
  );
}

function NewThreadIssue({ issue, retry }: { issue: string | null; retry(): void }) {
  return issue ? (
    <p role="status" className="text-xs text-warn mt-2 break-words">
      {issue}{" "}
      <TextButton type="button" underline tone="strong" onClick={retry}>
        Retry checks
      </TextButton>
    </p>
  ) : null;
}

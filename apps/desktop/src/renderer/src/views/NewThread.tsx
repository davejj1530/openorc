import { useSpaceProjects } from "../lib/space-queries";
import { newThreadWorkspaceMode, offeredAccount, projectAccountChoice, targetModel, type NewThreadDraft } from "@openorc/client";
import { WORKSPACE_ID, executionMode, type AppSettings, type ClaudeAccounts, type ModelOption, type Project, type SystemInfo } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer";
import { FolderPlus } from "../components/icons";
import { type PickerAccounts } from "../components/ModelPickerAccounts";
import { ComposerModelPicker, ModelPicker, type ModelChoice, type OrclingPickerChoices } from "../components/ModelPicker";
import { NewThreadOptions } from "../components/NewThreadOptions";
import { useMacStart } from "../components/MacStartLine";
import { loadProjectActivity, ProjectActivity } from "../components/ProjectActivity";
import { Panel } from "../components/Panel";
import { NewThreadQuestion } from "../components/ProjectPicker";
import { NewThreadMark } from "../components/NewThreadMark";
import { DitherBackdrop } from "../components/DitherBackdrop";
import { ThreadTabs } from "../components/ThreadTabs";
import { TopBar } from "../components/TopBar";
import { WorkingMark } from "../components/StateMark";
import { Button, TextButton } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { usePermissionSelection, useRpc, useRpcMutation } from "../lib/client";
import { useNewThreadHosted } from "../lib/cloud-offered";
import { CLOUD_MODEL_LIMITS } from "../lib/cloud-model-limits";
import { cloudRunChoice, useCloudModels } from "../lib/cloud-run-choice";
import { useCloudStartReady } from "../lib/use-cloud-start-ready";
import { useMounted } from "../lib/use-mounted";
import { cloudPicker } from "../lib/use-thread-accounts";
import { NewThreadStage, useCloudStart } from "./new-thread-starting";
import { useDefaultHarness } from "../lib/default-harness";
import { focusedProject, useLayout } from "../lib/layout";
import { swapInPlace } from "../lib/motion";
import { evaluateNewThreadAvailability, initialThreadChoice, type NewThreadIssue } from "../lib/new-thread-availability";
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
function newThreadAccounts(choices: ClaudeAccounts | undefined, current: string, blocked: string | undefined, choose: (id: string) => void, section: string | undefined): PickerAccounts | undefined {
  return choices ? { accounts: choices.accounts, current, choose, blocked, section } : undefined;
}

/**
 * While accounts are kept separate, a thread on another agent belongs to a Claude account too, so its picker offers
 * them in that agent's section.
 */
function otherAgentSection(settings: AppSettings | undefined, choice: ModelChoice | null): string | undefined {
  return settings?.claudeAccountsSeparate && choice && choice.agent !== "claude" ? choice.agent : undefined;
}

/** The Orclings the model picker offers, the one chosen marked. */
function orclingChoices(options: OrclingPickerChoices["options"], target: NewThreadDraft["target"], choose: (target: NewThreadDraft["target"]) => void): OrclingPickerChoices {
  return {
    options,
    selectedId: target.kind === "orcling" ? target.orclingId : null,
    onSelect: (orcling) => choose({ kind: "orcling", orclingId: orcling.id, name: orcling.name, settings: orcling.settings }),
  };
}

/** A cloud-only project has no folder on this Mac. Until the list arrives neither is known, so this Mac's checkout is asked nothing. */
function listedPlace(projects: Project[] | undefined, projectId: string, spaceId: string | null) {
  const listed = projects?.find((project) => project.id === projectId);
  return { cloudOnly: Boolean(spaceId && listed && !listed.rootPath), macFolder: Boolean(listed?.rootPath) };
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
  const { cloudOnly, macFolder } = listedPlace(projects, projectId, spaceId);
  const isWorkspace = projectId === WORKSPACE_ID;
  const git = useProjectGit(macFolder ? projectId : null);
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
  const mounted = useMounted();
  const cloudStart = useCloudStart();
  const changeDraft = (patch: Partial<NewThreadDraft>) => {
    const next = { ...draft, ...patch };
    setStorageError(writeNewThreadDraft(next) ? null : "This draft could not be saved on your device. Keep this task open while you work.");
    setDraft(next);
    start.reset();
  };
  const picked = targetModel(draft.target);
  const target = draft.target;
  // No thread action applies to the landing composer. Skills belong to the project or Workspace folder chosen here; a
  // cloud-only project has no folder on this Mac, so it offers none of this Mac's, as a cloud thread's composer does.
  const suggestions = useComposerSuggestions(projectScope(macFolder || isWorkspace ? projectId : null, draft.workingDirectory), picked?.agent, executionMode(draft.mode, permission), claudeAccountId);
  const hosted = useNewThreadHosted(target, projectId);
  const account = useRpc("account.status", {}).data;
  const workspaceMode = cloudOnly
    ? "hosted"
    : newThreadWorkspaceMode({
        canBranch: !isWorkspace && !git.cannotBranch,
        canHosted: hosted.can,
        chosen: draft.workspace,
        preferred: settings.data?.defaultWorkspaceMode,
      });
  // On OpenOrc Cloud the thread runs on the person's cloud sign-in, so this Mac's own agents and accounts never hold it.
  const onCloud = workspaceMode === "hosted";
  const files = useNewThreadFiles(projectId, onCloud);
  const chooseModel = (model: ModelChoice) => changeDraft({ target: { kind: "model", choice: model } });
  const { choice, runDraft } = useStartChoice({ draft, onCloud, models: models.data, info: info.data, defaultHarness, choose: chooseModel });

  const {
    selectedProject: selected,
    issue,
    disabledReason: targetDisabledReason,
  } = evaluateNewThreadAvailability({
    projectId,
    projects,
    projectsFailed: Boolean(projectsError),
    permissionReady,
    hosted: onCloud,
    target,
    choice,
    models: { data: models.data, failed: models.isError },
    system: { data: info.data, failed: info.isError },
  });
  const usesClaude = choice?.agent === "claude";
  // On OpenOrc Cloud, whatever folder it starts from, the person's cloud accounts take the place of this Mac's Claude accounts.
  const starting = start.isPending ? "Starting the thread…" : undefined;
  const cloudAccounts =
    onCloud && choice ? cloudPicker(account, { agent: choice.agent, model: choice.model, accountId: draft.cloudAccountId }, (id) => changeDraft({ cloudAccountId: id }), starting) : undefined;
  const macAccounts = orcling ? undefined : newThreadAccounts(accountChoices, claudeAccountId, starting, (id) => changeDraft({ claudeAccountId: id }), otherAgentSection(settings.data, choice));
  const pickerAccounts = onCloud ? cloudAccounts : macAccounts;
  const localReason = usesClaude && !accounts.data ? (accounts.error?.message ?? "Loading Claude accounts…") : targetDisabledReason;
  // A cloud start from this Mac's folder carries its work, said on the line above Start before anything leaves.
  const macStart = useMacStart(cloudOnly ? null : projectId, spaceId ?? undefined, onCloud);
  const disabledReason = onCloud ? (hosted.blocked?.words ?? macStart.refusal ?? (!hosted.shown ? "Checking OpenOrc Cloud…" : targetDisabledReason)) : localReason;
  const cloudStartReady = useCloudStartReady({ draft: runDraft, onCloud, held: Boolean(disabledReason), permissionMode: permission, spaceId });
  const location = useNewThreadLocation(projectId, selected, workspaceMode, draft.workingDirectory);
  const retry = () => {
    void accounts.refetch();
    void models.refetch();
    void info.refetch();
    onRetryProjects();
  };
  const pickerOrclings = isWorkspace || onCloud ? undefined : orclingChoices(orclings, target, (next) => changeDraft({ target: next }));

  const submit = async (text: string, attachments: string[]) => {
    const { generation, key } = spaceNavigation.getState();
    if (disabledReason) throw new Error(disabledReason);
    if (!choice || !selected || target.kind === "unavailable") throw new Error("Choose a project and execution target first.");
    // On OpenOrc Cloud the thread is the server's to make: until it is, the start shows as the thread it becomes.
    const starting = startNewThread({
      draft: { ...runDraft, claudeAccountId, ...(cloudAccounts && { cloudAccountId: cloudAccounts.current }) },
      project: selected,
      isWorkspace,
      workspaceMode,
      permissionMode: permission,
      text,
      attachments,
      files,
      launch: (params) => startSpaceThread(macStart.macWork ? { ...params, macWork: macStart.macWork } : params, start.mutateAsync, spaceId, key),
    });
    const threadId = await cloudStart.run(onCloud, { text, attachments, agent: choice.agent }, starting);
    if (mounted.current && spaceNavigation.getState().generation === generation && useRouter.getState().route.view === "newthread") openThread(threadId);
  };

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
                <NewThreadStage start={cloudStart.start}>
                  <NewThreadMark />
                  <NewThreadQuestion projectId={projectId} projects={projects} disabled={start.isPending} onProject={onProject} />
                  <div className="relative">
                    {macStart.line ? <div className="mb-2">{macStart.line}</div> : null}
                    <Composer
                      draftKey={files.draftKey}
                      hostedFiles={files.hostedFiles}
                      autoFocus
                      value={draft.prompt}
                      onChange={(prompt) => changeDraft({ prompt })}
                      onSubmit={submit}
                      onReady={cloudStartReady}
                      placeholder="Ask OpenOrc to build, fix bugs, explore"
                      size="lg"
                      presentation="new-thread"
                      model={choice}
                      onModel={chooseModel}
                      modelControl={
                        <NewThreadModelControl
                          choice={target.kind === "unavailable" ? null : choice}
                          choose={chooseModel}
                          orclings={pickerOrclings}
                          accounts={pickerAccounts}
                          onCloud={onCloud}
                          disabled={start.isPending}
                        />
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
                        hosted={hosted}
                        location={location}
                        blocked={branchingReason(git.state, "Worktrees")}
                        disabled={start.isPending}
                        onFolder={(workingDirectory) => changeDraft({ workingDirectory })}
                        onMode={(workspace) => changeDraft({ workspace })}
                      />
                    </Composer>
                  </div>
                  <NewThreadIssueLine issue={issue} retry={retry} />
                </NewThreadStage>
              </>
            )}
          </div>
          {cloudOnly || !projectId ? null : <ProjectActivity projectId={projectId} />}
        </div>
      </main>
      {panelContext ? <Panel context={panelContext} /> : null}
    </ClaudeAccountScope>
  );
}

/**
 * The model a start runs (`choice`) and the draft it starts from: the one chosen, and on OpenOrc Cloud one the cloud
 * runs, whatever agents this Mac has. With none chosen yet, the first one offered is chosen.
 */
function useStartChoice({
  draft,
  onCloud,
  models,
  info,
  defaultHarness,
  choose,
}: {
  draft: NewThreadDraft;
  onCloud: boolean;
  models: ModelOption[] | undefined;
  info: SystemInfo | undefined;
  defaultHarness: ReturnType<typeof useDefaultHarness>;
  choose: (choice: ModelChoice) => void;
}) {
  const { target } = draft;
  const cloudModels = useCloudModels(onCloud);
  const choice = cloudRunChoice(targetModel(target), onCloud ? cloudModels : undefined);
  useEffect(() => {
    const offered = (onCloud && cloudModels) || models;
    if (target.kind !== "model" || target.choice || !offered || defaultHarness === undefined) return;
    const initial = initialThreadChoice(offered, defaultHarness, info, onCloud);
    if (initial) choose(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `choose` is made anew each render; the offers decide
  }, [target, models, cloudModels, info, defaultHarness, onCloud]);
  return { choice, runDraft: choice && target.kind === "model" ? { ...draft, target: { kind: "model" as const, choice } } : draft };
}

/** The model the thread starts with. On OpenOrc Cloud it offers what a cloud thread's composer does: the agents the cloud runs. */
function NewThreadModelControl({
  choice,
  choose,
  orclings,
  accounts,
  onCloud,
  disabled,
}: {
  choice: ModelChoice | null;
  choose: (choice: ModelChoice) => void;
  orclings: OrclingPickerChoices | undefined;
  accounts: PickerAccounts | undefined;
  onCloud: boolean;
  disabled: boolean;
}) {
  const limits = onCloud ? CLOUD_MODEL_LIMITS : undefined;
  if (!choice) return <ModelPicker value={null} onChange={choose} orclings={orclings} limits={limits} disabled={disabled} />;
  return <ComposerModelPicker value={choice} onChange={choose} onSelectModel={choose} orclings={orclings} accounts={accounts} limits={limits} disabled={disabled} />;
}

/** What holds the start back, under the composer: a read under way as the mark at work, a problem with a way to try again. */
function NewThreadIssueLine({ issue, retry }: { issue: NewThreadIssue | null; retry(): void }) {
  if (!issue) return null;
  if (issue.waiting) {
    return (
      <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-ink-3">
        <WorkingMark size={12} />
        {issue.words}
      </p>
    );
  }
  return (
    <p role="status" className="text-xs text-warn mt-2 break-words">
      {issue.words}{" "}
      <TextButton type="button" underline tone="strong" onClick={retry}>
        Retry checks
      </TextButton>
    </p>
  );
}

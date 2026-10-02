import { SavedTeamTaskHint, TeamActorExplanation } from "./TeamActivityNotes";
import { durableActionLabel, teamMessageHint, teamAttentionLabel, teamActorStateLabel, teamReplyForkDescription } from "../lib/conversation-status-presentation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ModelExecutionSettings,
  PermissionPreset,
  Project,
  RunMode,
  Task,
  TeamActionAvailability,
  TeamMemberAvatarChoice,
  TeamActorView,
  TeamChatEntry,
  TeamReadReceipt,
  TeamConversation as TeamConversationData,
  TeamExecutionView,
  TeamPermissionState,
  TeamRevision,
  Thread,
  ThreadSummary,
} from "@openorc/protocol";
import { Composer, permissionLabel } from "./Composer";
import { useComposerChanges } from "../lib/composer-changes";
import { TeamLeadPicker } from "./TeamLeadPicker";
import { AgentPresence, Transcript, TranscriptContents } from "./Transcript";
import { ThreadMedia, useThreadMentionNames } from "./ThreadImages";
import { MemberAvatar } from "./MemberAvatar";
import { orclingById, useOrclings } from "../lib/orclings";
import { AlertCircle, ChevronDown, Folder, GitFork, Workflow } from "./icons";
import { Button, TextButton, Tooltip } from "./ui";
import { emptyRun, getRun, hydrate, useRun, useRunMap, useRuns, type Block, type RunTranscript } from "../lib/transcript";
import { useRpc, useRpcMutation } from "../lib/query";
import { readDraft, writeDraft } from "../lib/drafts";
import { openTask, openThread } from "../lib/router";
import { useSkillCommands } from "../lib/skill-commands";
import { useModelEffortLabel } from "../lib/model-effort-label";
import { cn } from "../lib/cn";
import { teamActivityGroups, teamMemberActivity, teamChatDeliveryStatus, teamDirectionStatus, teamFileList, teamRunBlocks } from "../lib/team-activity";
import { isTeamMember, teamFeed, teamWorkingStatus, type TeamFeedItem } from "../lib/team-feed";
import { teamMentionEntries } from "../lib/composer-mentions";
import type { TeamPolicy } from "../lib/team-settings";
import { actorContextCheckpoints, beginTeamContextRequest, finishTeamContextRequest, readTeamContextRequest, teamContextHistory, type TeamContextCheckpoint } from "../lib/team-context";
import { teamModeCounts, teamModeStatus, teamModeStatusText, teamPermissionCounts, teamPermissionStatus, teamPermissionStatusText, teamPolicyControlReason } from "../lib/team-permissions";
import { teamSendDisabledReason } from "../lib/team-send-availability";
import { teamControlParams } from "../lib/team-control-scope";
import { useTeamConversationSettings } from "./useTeamConversationSettings";
import { useRecoverableTeamSend, useTeamConversationDraft } from "./useTeamConversationMessage";
import { TeamTaskAdmissions, TeamTaskStart } from "./TeamTaskStart";
import { useTeamFork, type TeamForkControls } from "../lib/use-team-fork";
import { teamForkReplyId } from "../lib/team-fork-reply";
import { TeamWorkTranscript } from "./TeamWorkTranscript";
import { teamAttention, teamRequestSummary } from "../lib/team-attention";
import { teamChatText } from "../lib/team-transcript";
import { teamMentionNames } from "../lib/mention-names";
import { TeamChangeCard } from "./TeamChangeCard";
import "./TeamConversation.css";

// Extend the native conversation: one reading column, one time-ordered feed in
// which members appear only when they act, and team controls beside the draft.
const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const mentionHint = "Mention @name to address a member, @everyone for the whole team. Without a mention the lead replies.";
const stateLabel: Record<TeamActorView["state"], string> = {
  queued: "Queued",
  starting: "Preparing",
  running: "Working",
  waiting: "Waiting for reports",
  attention: "Needs attention",
  completed: "Completed",
  cancelled: "Stopped",
};
function executionLabel(execution: TeamExecutionView): string {
  if (execution.state === "completed") return "Completed";
  if (execution.state === "stopped") return "Stopped";
  if (execution.state === "stopping") return "Stopping…";
  if (execution.activity === "attention") return "Needs attention";
  if (execution.activity === "waiting") return "Needs you";
  return "Working";
}
const isOpen = (execution: TeamExecutionView | undefined) => Boolean(execution && execution.state !== "completed" && execution.state !== "stopped");
const emptyTranscript = (id: string): RunTranscript => ({ ...emptyRun(id), hydrated: true });
const userBlock = (id: string, text: string, attachments: string[] = []): Block => ({ kind: "message", id, text, attachments, role: "user", streaming: false });
// A deleted owner survives only for its saved tasks; every control on it is
// authorized through the task being viewed, so nested actions read that scope.
const TeamActivityVisibility = createContext(true);
const TeamAttentionTarget = createContext<{ id: string; select: (id: string) => void } | null>(null);
const TeamControlScope = createContext<string | undefined>(undefined);
const useTeamControl = (threadId: string) => teamControlParams(threadId, useContext(TeamControlScope));
// Pictures are read once per conversation; every author line and card looks its member up here.
const TeamAvatars = createContext<{ choices: ReadonlyMap<string, TeamMemberAvatarChoice>; roster: readonly string[]; seats: ReadonlyMap<string, string> }>({
  choices: new Map(),
  roster: [],
  seats: new Map(),
});

/** The member's picture beside its name, or the face of the Orcling in its seat; its roster position stands in until the saved choice loads. */
function TeamMemberPicture({ memberKey, size }: { memberKey: string; size: "sm" | "md" | "lg" }) {
  const { choices, roster, seats } = useContext(TeamAvatars);
  const orcling = orclingById(useOrclings(), seats.get(memberKey));
  return <MemberAvatar avatar={choices.get(memberKey) ?? null} orcling={orcling} fallbackIndex={Math.max(0, roster.indexOf(memberKey))} size={size} />;
}

export function TeamConversation({
  thread,
  project,
  data,
  refresh,
  refreshError,
  retainedTaskId,
}: {
  thread: Thread | ThreadSummary;
  project: Project;
  data: TeamConversationData;
  refresh: () => void;
  refreshError: string | null;
  retainedTaskId?: string;
}) {
  const [showActivity, setShowActivity] = useState(() => readDraft("team.showActivity", { enabled: false }).enabled === true);
  const attentionId = useId();
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const attentionTarget = useMemo(() => ({ id: attentionId, select: setSelectedRequest }), [attentionId]);
  const conversationRef = useRef<HTMLDivElement>(null);
  const retained = Boolean(retainedTaskId);
  const composerChanges = useComposerChanges(retained ? null : { kind: "thread", id: thread.id, projectName: project.name, team: true });
  const control = teamControlParams(thread.id, retainedTaskId);
  const fork = useTeamFork(thread.id, !retained);
  const retainedTask = useRpc("orchestration.taskState", { taskId: retainedTaskId ?? "" }, { enabled: retained });
  const availability = useRpc("orchestration.availability", {});
  const stop = useRpcMutation("orchestration.stop");
  const compact = useRpcMutation("orchestration.compact");
  const compactRequest = useTeamContextAction(`conversation.${thread.id}.context.compact`, (requestKey) => compact.mutateAsync({ ...control, requestKey }));
  const compactDescriptionId = useId();
  const permissionDescriptionId = useId();
  const modeDescriptionId = useId();
  const last = data.executions.at(-1);
  const active = isOpen(last);
  const lead = data.revision.members.find((member) => member.managerKey === null)!;
  const avatars = useRpc("orchestration.avatars.list", { teamId: data.revision.teamId });
  const memberAvatars = useMemo(
    () => ({
      choices: new Map(avatars.data?.map((item) => [item.memberKey, item.avatar] as const) ?? []),
      roster: data.revision.members.map((member) => member.key),
      seats: new Map(data.revision.members.flatMap((member) => (member.orclingId ? [[member.key, member.orclingId] as const] : []))),
    }),
    [avatars.data, data.revision.members],
  );
  const settings = useTeamConversationSettings({ thread, data, leadSettings: lead.settings, retainedTaskId });
  const { draftKey, prompt, changePrompt, error: draftError, reportError: reportDraftError } = useTeamConversationDraft(thread, retainedTaskId);
  const message = useRecoverableTeamSend({ threadId: thread.id, retainedTaskId, waitForSaved: settings.waitForSaved, changePrompt, reportDraftError });
  const { effective, editingChoice, saving: leadSaving, error: leadError, change: changeLead, reset: resetLead } = settings.lead;
  const {
    value: policy,
    editing: editingPolicy,
    saving: policySaving,
    error: policyError,
    change: changePolicy,
    reset: resetPolicy,
    report: permissionReport,
    reportPending: permissionReportPending,
    reportError: permissionReportError,
    refreshReport: refreshPermissionReport,
  } = settings.policy;
  const members = data.revision.members.filter((member) => member.managerKey !== null);
  const mentions = teamMentionEntries(data.revision);
  const disabledReason = teamSendDisabledReason({
    retained,
    active,
    archived: Boolean(thread.archivedAt),
    refreshFailed: Boolean(refreshError),
    stopping: last?.state === "stopping",
    teamEnabled: Boolean(availability.data?.enabled),
    availabilityReason: availability.data?.reason,
  });
  const canSteer = active && Boolean(data.steer?.allowed) && !disabledReason;
  // A team thread reaches the same skills as any other. Its own actions are
  // the lead controls in the toolbar, not "/" commands, so these stand alone.
  const skillCommands = useSkillCommands(project.id, lead.settings.agent);
  const error = message.error ?? stop.error?.message ?? leadError ?? policyError;
  const compactReason = refreshError
    ? "Refresh team activity before compacting context."
    : (data.context?.compact.reason ?? (!data.context ? "Refresh team activity to check context actions." : null));
  const working = active && last ? teamWorkingStatus(last.actors, data.revision.members) : null;
  const compactDescription = compactRequest.pending
    ? "Retry the saved request to confirm whether context was compacted. Your history and files are kept."
    : (compactReason ?? "Start the lead’s next session from a short local handoff. Your history and files are kept.");
  const modeReportMissing = active && !permissionReport?.mode;
  const permissionReportMissing = active && !data.policy;
  const modeControlReason = teamPolicyControlReason({ control: "mode", saveFailed: Boolean(policyError), refreshFailed: Boolean(refreshError), reportMissing: modeReportMissing });
  const permissionControlReason = teamPolicyControlReason({ control: "permission", saveFailed: Boolean(policyError), refreshFailed: Boolean(refreshError), reportMissing: permissionReportMissing });
  function renderComposerHint() {
    if (retained && !active) return <SavedTeamTaskHint task={retainedTask.data} taskId={retainedTaskId} pending={retainedTask.isPending} retry={() => void retainedTask.refetch()} />;
    if (thread.archivedAt && !retained) return <p className="team-composer-hint">This task is archived. Unarchive it from the task menu to send a message.</p>;
    return (
      <p className="team-composer-hint">
        {teamMessageHint({ active: Boolean(active), hasMembers: Boolean(members.length), hasMention: prompt.includes("@"), canSteer, steerReason: data.steer?.reason, mentionHint })}
        {last?.state === "attention" ? " Resolve the recovery details above to continue." : ""}
      </p>
    );
  }
  return (
    <TeamControlScope.Provider value={retainedTaskId}>
      <TeamAvatars.Provider value={memberAvatars}>
        <TeamActivityVisibility.Provider value={showActivity}>
          <TeamAttentionTarget.Provider value={attentionTarget}>
            <div ref={conversationRef} className="team-conversation h-full flex flex-col min-h-0" data-team-thread={thread.id} data-team-retained-task={retainedTaskId}>
              <div className="team-conversation-heading">
                <Workflow size={15} />
                <span className="team-conversation-name">{data.revision.name}</span>
                <span className="text-ink-3">Version {data.revision.number}</span>
                <span className="team-conversation-status" role="status">
                  {last ? executionLabel(last) : "Ready"}
                </span>
                {working ? (
                  <span className="text-ink-3" data-team-working>
                    {working}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="team-activity-toggle"
                  aria-pressed={showActivity}
                  onClick={() => {
                    const enabled = !showActivity;
                    setShowActivity(enabled);
                    writeDraft("team.showActivity", { enabled });
                  }}
                >
                  Show activity
                </Button>
                {retained && !data.context?.compact ? null : (
                  <>
                    <Tooltip label={compactDescription}>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-describedby={compactDescriptionId}
                        disabled={compactRequest.working || (!compactRequest.pending && (!data.context?.compact.allowed || Boolean(refreshError)))}
                        onClick={compactRequest.run}
                      >
                        {durableActionLabel({ working: compactRequest.working, pending: Boolean(compactRequest.pending), labels: ["Compact lead context", "Retry compact request", "Compacting…"] })}
                      </Button>
                    </Tooltip>
                    <span id={compactDescriptionId} className="sr-only">
                      {compactDescription}
                    </span>
                  </>
                )}
              </div>
              {showActivity && active && last ? <TeamActivityStrip execution={last} revision={data.revision} /> : null}
              {refreshError ? (
                <div className="team-refresh-error" role="alert">
                  Could not refresh team activity.{" "}
                  <Button size="sm" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
              {compactRequest.error ? (
                <div className="team-refresh-error" role="alert">
                  {compactRequest.error}
                </div>
              ) : null}
              <TeamTimeline thread={thread} project={project} data={data} retainedTaskId={retainedTaskId} deletedAt={retainedTask.data?.ownerDeletedAt} fork={retained ? undefined : fork} />
              <div className="composer-padding shrink-0 px-6 pb-6 pt-2">
                <div className="max-w-chat mx-auto grid gap-2">
                  {renderComposerHint()}
                  {message.request && (message.restored || message.error) && message.request.body === (prompt.trim() || "See the attached image.") ? (
                    <p className="team-composer-hint">Retry confirms the saved {message.request.now ? "live" : "queued"} message request.</p>
                  ) : null}
                  <TeamPermissions
                    data={data}
                    report={permissionReport}
                    requested={policy.permissionMode}
                    mode={policy.mode}
                    active={active}
                    saving={policySaving}
                    failed={Boolean(policyError)}
                    editing={editingPolicy}
                    refreshing={permissionReportPending}
                    descriptionId={permissionDescriptionId}
                    modeDescriptionId={modeDescriptionId}
                  />
                  {permissionReportError ? (
                    <div className="team-composer-hint" role="alert">
                      Could not refresh current agent mode and permissions.{" "}
                      <Button size="sm" variant="ghost" onClick={() => void refreshPermissionReport()}>
                        Retry agent status
                      </Button>
                    </div>
                  ) : null}
                  {editingChoice && leadError && !leadSaving ? (
                    <div className="team-recovery" role="alert">
                      <p>Lead settings could not be saved. Your selected settings and message are retained.</p>
                      <div className="team-recovery-actions">
                        <Button size="sm" onClick={() => changeLead(editingChoice)}>
                          Retry lead settings
                        </Button>
                        <Button size="sm" variant="ghost" onClick={resetLead}>
                          Use saved lead settings
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {editingPolicy && policyError && !policySaving ? (
                    <div className="team-recovery" role="alert">
                      <p>Mode or permissions could not be saved. Your selected settings and message are retained.</p>
                      <div className="team-recovery-actions">
                        <Button size="sm" onClick={() => changePolicy(editingPolicy)}>
                          Retry mode and permissions
                        </Button>
                        <Button size="sm" variant="ghost" onClick={resetPolicy}>
                          Use saved mode and permissions
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <TeamAttention data={data} threadId={thread.id} project={project} id={attentionId} conversationRef={conversationRef} selected={selectedRequest} onSelect={setSelectedRequest} />
                  <Composer
                    value={prompt}
                    onChange={changePrompt}
                    onSubmit={message.submit}
                    draftKey={`${draftKey}.attachments`}
                    placeholder="Message the team…"
                    mentions={mentions}
                    model={editingChoice ?? effective}
                    onModel={changeLead}
                    modelControl={<TeamLeadPicker revision={data.revision} value={editingChoice ?? effective} onChange={changeLead} saving={leadSaving} />}
                    onExecutionMode={changePolicy}
                    mode={policy.mode}
                    onMode={(mode) => changePolicy({ mode })}
                    permission={policy.permissionMode}
                    onPermission={(permissionMode) => changePolicy({ permissionMode })}
                    settingsDisabled={policySaving || Boolean(policyError) || Boolean(refreshError) || modeReportMissing}
                    settingsDisabledReason={modeControlReason}
                    modeDescriptionId={modeDescriptionId}
                    permissionDisabled={policySaving || Boolean(policyError) || Boolean(refreshError) || permissionReportMissing}
                    permissionDisabledReason={permissionControlReason}
                    permissionDescriptionId={permissionDescriptionId}
                    hasStarted={data.executions.length > 0}
                    location={{ label: thread.workspaceMode === "current" ? "Local checkout" : "Worktree", branch: thread.branch }}
                    changes={composerChanges}
                    projectId={project.id}
                    commands={skillCommands}
                    busy={message.pending || leadSaving || policySaving || compactRequest.working}
                    disabledReason={disabledReason}
                    queueing={active}
                    steerable={canSteer}
                    liveByDefault
                    steerReason={disabledReason ?? data.steer?.reason ?? null}
                    stopAction={{
                      working: active,
                      pending: stop.isPending,
                      onStop: () => {
                        if (last) stop.mutate({ ...control, executionId: last.id });
                      },
                    }}
                    error={error ?? draftError}
                  />
                </div>
              </div>
            </div>
          </TeamAttentionTarget.Provider>
        </TeamActivityVisibility.Provider>
      </TeamAvatars.Provider>
    </TeamControlScope.Provider>
  );
}

/** The time-ordered conversation feed owns its transcript projection and activity cards. */
function TeamTimeline({
  thread,
  project,
  data,
  retainedTaskId,
  deletedAt,
  fork,
}: {
  thread: Thread | ThreadSummary;
  project: Project;
  data: TeamConversationData;
  retainedTaskId?: string;
  deletedAt?: number | null;
  fork?: TeamForkControls;
}) {
  const retained = Boolean(retainedTaskId);
  const last = data.executions.at(-1);
  const leadName = data.revision.members.find((member) => member.managerKey === null)!.name;
  const checkpoints = data.context?.checkpoints ?? [];
  const transcript = useMemo(() => emptyTranscript(thread.id), [thread.id]);
  const mentionNames = useMemo(() => teamMentionNames(data.revision.members, data.instance.members), [data.revision.members, data.instance.members]);
  return (
    <div className="flex-1 min-h-0" data-team-transcript>
      <Transcript run={transcript} scrollKey={thread.id} basePath={thread.worktreePath ?? project.rootPath} fileScope={{ kind: "thread", id: thread.id }} mentionNames={mentionNames}>
        {data.origin ? (
          <div className="team-context-notice" data-team-origin={data.origin.sourceThreadId}>
            <p>
              Forked from{" "}
              {data.origin.sourceExists ? (
                <TextButton type="button" underline className="text-ink-2 hover:text-ink" onClick={() => openThread(data.origin!.sourceThreadId)}>
                  {data.origin.sourceTitle}
                </TextButton>
              ) : (
                <span className="text-ink-2">{data.origin.sourceTitle}</span>
              )}
              .
            </p>
            <p>This team has its own workspace. Earlier context is available to the lead.</p>
          </div>
        ) : null}
        {retained ? (
          <div className="team-context-notice" data-team-deleted-owner={retainedTaskId}>
            <p>
              This conversation was deleted
              {deletedAt ? (
                <>
                  {" "}
                  on <time dateTime={new Date(deletedAt).toISOString()}>{new Date(deletedAt).toLocaleString()}</time>
                </>
              ) : null}
              . Its team, activity and workspaces are kept for this saved task.
            </p>
          </div>
        ) : null}
        {teamContextHistory(data.executions, checkpoints, data.workspaceRestores, data.workspaceMoves).map((item) => {
          if (item.kind === "checkpoint") return <ContextNotice key={item.checkpoint.id} checkpoint={item.checkpoint} actorName={leadName} />;
          if (item.kind === "restore")
            return (
              <div key={item.restore.id} className="team-context-notice" data-team-workspace-restore={item.restore.id}>
                <div>
                  <strong>Workspace restored</strong>
                  <time dateTime={new Date(item.restore.createdAt).toISOString()}>{new Date(item.restore.createdAt).toLocaleString()}</time>
                </div>
                <p>Checkpoint files are in a new team workspace. The previous workspace and conversation are kept.</p>
              </div>
            );
          if (item.kind === "move")
            return (
              <div key={item.move.id} className="team-context-notice" data-team-workspace-move={item.move.id}>
                <div>
                  <strong>{item.move.to === "current" ? "Team moved to the checkout" : "Team moved to a worktree"}</strong>
                  <time dateTime={new Date(item.move.createdAt).toISOString()}>{new Date(item.move.createdAt).toLocaleString()}</time>
                </div>
                <p>
                  {item.move.to === "current"
                    ? "The team conversation continues in the local checkout. Delegated assignments keep their isolated workspaces."
                    : "The team conversation continues in its worktree. Unrelated local work stays in the checkout."}
                </p>
              </div>
            );
          return <ExecutionActivity key={item.execution.id} execution={item.execution} revision={data.revision} threadId={thread.id} project={project} checkpoints={checkpoints} fork={fork} />;
        })}
        {data.executions.length === 0 ? <p className="text-sm text-ink-3">Send an instruction to start this team.</p> : null}
        <AgentPresence
          working={last?.activity === "working"}
          since={Math.max(
            last?.createdAt ?? 0,
            ...(last?.actors.flatMap((actor) => (actor.activeRunId ? actor.runs.filter((run) => run.id === actor.activeRunId).map((run) => run.startedAt) : [])) ?? []),
          )}
        />
      </Transcript>
    </div>
  );
}

/** Requests remain reachable while the conversation scrolls; hidden panels retain answer drafts. */
function TeamAttention({
  data,
  threadId,
  project,
  id,
  conversationRef,
  selected,
  onSelect,
}: {
  data: TeamConversationData;
  threadId: string;
  project: Project;
  id: string;
  conversationRef: { current: HTMLDivElement | null };
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const runs = useRunMap(data.executions.flatMap((execution) => execution.actors.flatMap((actor) => actor.runIds)));
  const items = teamAttention(data.executions, runs);
  const current = items.find((item) => item.id === selected) ?? items[0];
  const name = (memberKey: string) => data.revision.members.find((member) => member.key === memberKey)?.name ?? memberKey;
  const label = (item: (typeof items)[number]) =>
    item.kind === "publication"
      ? "Changes need review"
      : `${name(item.actor.memberKey)} · ${teamAttentionLabel({ approval: item.kind === "approval", question: item.kind === "approval" && item.block.approvalKind === "user_input" })}`;
  const viewContext = () => {
    if (!current) return;
    const root = conversationRef.current;
    const execution = [...(root?.querySelectorAll<HTMLElement>("[data-team-execution]") ?? [])].find((node) => node.dataset.teamExecution === current.execution.id);
    const request = current.kind === "approval" ? [...(execution?.querySelectorAll<HTMLElement>("[data-team-request]") ?? [])].find((node) => node.dataset.teamRequest === current.id) : undefined;
    const actor =
      current.kind === "publication"
        ? execution
        : (request?.closest<HTMLElement>("[data-team-actor]") ??
          [...(execution?.querySelectorAll<HTMLElement>("[data-team-actor]") ?? [])].findLast((node) => node.dataset.teamActor === current.actor.id) ??
          execution);
    // Assignments keep their transcript mounted beneath their own disclosure.
    actor?.querySelector<HTMLButtonElement>(".team-member-toggle[aria-expanded=false]")?.click();
    requestAnimationFrame(() => {
      const target = request ?? actor;
      target?.scrollIntoView({ block: "center" });
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
  };
  if (!current) return null;
  function renderAttentionContent(item: (typeof items)[number]) {
    if (item.kind === "approval")
      return (
        <ThreadMedia
          scopeKey={item.runId}
          basePath={item.actor.workspace?.path ?? project.rootPath}
          fileScope={item.actor.taskId ? { kind: "task", id: item.actor.taskId } : { kind: "thread", id: threadId }}
        >
          <TranscriptContents runId={item.runId} blocks={[item.block]} taskCards={false} />
        </ThreadMedia>
      );
    if (item.kind === "actor")
      return (
        <>
          {item.actor.modeHold ? <p>Switch to Act to continue {name(item.actor.memberKey)}’s assignment.</p> : null}
          <ActorRecovery actor={item.actor} execution={item.execution} threadId={threadId} />
        </>
      );
    return <PublicationRecovery receipt={item.receipt} executionId={item.execution.id} threadId={threadId} />;
  }
  return (
    <section id={id} tabIndex={-1} className="team-attention" aria-label="Needs your attention">
      <div className="team-attention-heading">
        <strong>Needs you</strong>
        {items.length > 1 ? (
          <label className="team-attention-select">
            <span>{items.length} pending</span>
            <select aria-label="Pending requests" value={current.id} onChange={(event) => onSelect(event.target.value)}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {label(item)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>{label(current)}</span>
        )}
        <TextButton onClick={viewContext}>View context</TextButton>
      </div>
      {items.map((item) => (
        <div key={item.id} hidden={item.id !== current.id} className="team-attention-content">
          {renderAttentionContent(item)}
        </div>
      ))}
    </section>
  );
}

/** One execution of the feed. Its boundary is invisible; only recovery makes it show. */
function ExecutionActivity({
  execution,
  revision,
  threadId,
  project,
  checkpoints,
  fork,
}: {
  execution: TeamExecutionView;
  revision: TeamRevision;
  threadId: string;
  project: Project;
  checkpoints: TeamContextCheckpoint[];
  fork?: TeamForkControls;
}) {
  const lead = execution.actors.find((actor) => actor.parentId === null)!;
  const leadName = revision.members.find((member) => member.key === lead.memberKey)!.name;
  const deliveryContext = { executionState: execution.state, leadState: lead.state };
  const feed = teamFeed(execution, checkpoints);
  const memberName = (actor: TeamActorView) => revision.members.find((member) => member.key === actor.memberKey)?.name ?? actor.memberKey;
  return (
    <section className="team-execution" data-team-execution={execution.id} aria-label={`Team execution · ${executionLabel(execution)}`}>
      {feed.map((item) => {
        switch (item.kind) {
          case "prompt":
            return (
              <div key="prompt">
                <TranscriptContents runId={execution.id} blocks={[userBlock(`instruction-${execution.id}`, execution.initialPrompt.text, execution.initialPrompt.attachments)]} taskCards={false} />
                <TeamSeenBy seenBy={execution.initialPrompt.seenBy} />
              </div>
            );
          case "direction":
            return <TeamDirection key={item.direction.id} direction={item.direction} threadId={threadId} executionId={execution.id} leadName={leadName} deliveryContext={deliveryContext} />;
          case "chat":
            return <TeamChatMessage key={item.entry.id} entry={item.entry} execution={execution} continued={item.continued} />;
          case "turn":
            return <TeamTurn key={item.turnId} item={item} name={memberName(item.actor)} execution={execution} threadId={threadId} project={project} fork={item.actor === lead ? fork : undefined} />;
          case "checkpoint":
            return <ContextNotice key={item.checkpoint.id} checkpoint={item.checkpoint} actorName={memberName(item.actor)} />;
          case "assignment":
            return (
              <div key={item.actor.id} className="team-member-list" aria-label="Agent assignments">
                <TeamMemberCard actor={item.actor} execution={execution} revision={revision} threadId={threadId} project={project} checkpoints={checkpoints} />
              </div>
            );
        }
      })}
      {/* A member that never got a turn has no block to carry its recovery. */}
      {execution.actors
        .filter((actor) => isTeamMember(actor) && !actor.runIds.length)
        .map((actor) => (
          <ActorRecovery key={actor.id} actor={actor} execution={execution} threadId={threadId} />
        ))}
      {execution.publications
        .filter((receipt) => receipt.state !== "applied")
        .map((receipt) => (
          <PublicationRecovery key={receipt.id} receipt={receipt} executionId={execution.id} threadId={threadId} />
        ))}
    </section>
  );
}

/** Name, the model and effort the turn ran with, and time, once per consecutive block from the same member. */
function TeamAuthor({
  name,
  memberKey,
  settings,
  at,
  live,
  note,
}: {
  name: string;
  memberKey: string | null;
  settings: ModelExecutionSettings | null;
  at: number | undefined;
  live?: boolean;
  note?: string;
}) {
  const model = useModelEffortLabel(settings);
  return (
    <header className="team-turn-author">
      {memberKey ? <TeamMemberPicture memberKey={memberKey} size="lg" /> : null}
      <strong>{name}</strong>
      {model ? <span>{model}</span> : null}
      {at !== undefined ? <time dateTime={new Date(at).toISOString()}>{clockTime(at)}</time> : null}
      {note ? <span>{note}</span> : null}
      {live ? <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" role="status" aria-label="Working" /> : null}
    </header>
  );
}

/** One provider turn of a roster member: thinking, tools, reply and the files it changed. */
function TeamTurn({
  item,
  name,
  execution,
  threadId,
  project,
  fork,
}: {
  item: Extract<TeamFeedItem, { kind: "turn" }>;
  name: string;
  execution: TeamExecutionView;
  threadId: string;
  project: Project;
  fork: TeamForkControls | undefined;
}) {
  const { actor, runId } = item;
  const run = actor.runs?.find((candidate) => candidate.turnId === item.turnId);
  const ambient = run?.reason === "ambient";
  const live = actor.activeRunId === runId && item.turnId === actor.runs?.at(-1)?.turnId;
  if (ambient)
    return (
      <div className="team-ambient-work" data-team-actor={actor.id} data-team-member={actor.memberKey}>
        <ThreadMedia scopeKey={item.turnId} basePath={actor.workspace?.path ?? project.rootPath} fileScope={{ kind: "thread", id: threadId }}>
          <RunActivity runId={runId} turn={item.turn} ambient author={name} live={live} />
        </ThreadMedia>
        {item.last ? <ActorRecovery actor={actor} execution={execution} threadId={threadId} /> : null}
      </div>
    );
  return (
    <section
      className={cn("team-turn", item.continued && "team-turn-continued")}
      aria-label={`${name}’s turn`}
      data-team-actor={actor.id}
      data-team-member={actor.memberKey}
      data-team-participant={actor.participant || undefined}
      data-team-parent={actor.parentId ?? undefined}
    >
      {item.continued ? null : <TeamAuthor name={name} memberKey={actor.memberKey} settings={run?.settings ?? actor.settings} at={item.at} live={live} />}
      <ThreadMedia scopeKey={item.turnId} basePath={actor.workspace?.path ?? project.rootPath} fileScope={{ kind: "thread", id: threadId }}>
        <RunActivity runId={runId} turn={item.turn} live={live} fork={fork} />
      </ThreadMedia>
      <RunChangedFiles run={run} threadId={threadId} executionId={execution.id} />
      {item.last && actor.claims?.length ? (
        <p
          className="team-member-files"
          title={
            actor.claims
              .map((claim) => claim.note)
              .filter(Boolean)
              .join("\n") || undefined
          }
          data-team-claims={actor.claims.map((claim) => claim.path).join(",")}
        >
          Holding: <code>{teamFileList(actor.claims.map((claim) => claim.path))}</code>
        </p>
      ) : null}
      {item.last ? <ActorRecovery actor={actor} execution={execution} threadId={threadId} /> : null}
    </section>
  );
}

/** A user message to members is a bubble; a member's message reads like its turn, with whom it addressed. */
function TeamChatMessage({ entry, execution, continued }: { entry: TeamChatEntry; execution: TeamExecutionView; continued: boolean }) {
  const mentionNames = useThreadMentionNames();
  const fromUser = entry.senderId === "user";
  const sender = execution.actors.find((actor) => actor.id === entry.senderId);
  return (
    <div className={cn("team-chat-entry", fromUser && "team-chat-entry-user", !fromUser && continued && "team-turn-continued")} data-team-chat={entry.id} data-team-chat-sender={entry.senderId}>
      {fromUser ? (
        <TranscriptContents runId={execution.id} blocks={[userBlock(`chat-${entry.id}`, entry.text, entry.attachments)]} taskCards={false} />
      ) : (
        <>
          {continued ? null : <TeamAuthor name={entry.senderName} memberKey={sender?.memberKey ?? null} settings={sender?.settings ?? null} at={entry.createdAt} />}
          <TranscriptContents
            runId={execution.id}
            blocks={[{ kind: "message", id: `chat-${entry.id}`, role: "assistant", text: teamChatText(entry, mentionNames), streaming: false }]}
            taskCards={false}
          />
        </>
      )}
      {fromUser ? <TeamSeenBy seenBy={entry.seenBy} /> : null}
      <ul className="team-chat-delivery" aria-label="Delivery">
        {entry.to
          .filter((recipient) => recipient.state !== "delivered" && (fromUser || recipient.state === "cancelled" || recipient.live === "uncertain"))
          .map((recipient) => (
            <li key={recipient.actorId} data-team-chat-to={recipient.actorId} data-delivery-state={recipient.state} title={recipient.waitReason}>
              {entry.to.length > 1 || !fromUser ? `${recipient.name} ${teamChatDeliveryStatus(recipient)}` : teamChatDeliveryStatus(recipient)}
            </li>
          ))}
      </ul>
    </div>
  );
}

function TeamSeenBy({ seenBy }: { seenBy: TeamReadReceipt[] | undefined }) {
  const { roster } = useContext(TeamAvatars);
  if (!seenBy?.length) return null;
  return (
    <p className="team-seen-by" role="status">
      Seen by {roster.length > 0 && new Set(seenBy.map((member) => member.actorId)).size === roster.length ? "everyone" : seenBy.map((member) => member.name).join(", ")}
    </p>
  );
}

function TeamDirection({
  direction,
  threadId,
  executionId,
  leadName,
  deliveryContext,
}: {
  direction: TeamExecutionView["userDirections"][number];
  threadId: string;
  executionId: string;
  leadName: string;
  deliveryContext: Parameters<typeof teamDirectionStatus>[2];
}) {
  const cancel = useRpcMutation("orchestration.cancelDirection");
  const sendNow = useRpcMutation("orchestration.sendNow");
  const scope = useTeamControl(threadId);
  const [acknowledgedCancellation, setAcknowledgedCancellation] = useState(false);
  const shown = acknowledgedCancellation ? { ...direction, state: "cancelled" as const } : direction;
  const status = shown.state === "delivered" && direction.seenBy?.length ? null : teamDirectionStatus(shown, leadName, deliveryContext);
  return (
    <div data-team-direction={direction.id} data-delivery-state={shown.state} data-team-direction-from={direction.from?.threadId}>
      {direction.from ? <p className="team-direction-status">From thread {direction.from.title ?? "no longer available"}</p> : null}
      <TranscriptContents runId={executionId} blocks={[userBlock(direction.id, direction.text, direction.attachments ?? [])]} taskCards={false} />
      <TeamSeenBy seenBy={direction.seenBy} />
      <div className="team-direction-footer">
        {status ? (
          <p className="team-direction-status" role="status" title={direction.waitReason}>
            {status}
          </p>
        ) : null}
        {shown.state === "pending" && direction.sendNow ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!direction.sendNow.allowed || sendNow.isPending}
            title={direction.sendNow.reason ?? undefined}
            onClick={() => sendNow.mutate({ ...scope, executionId, messageId: direction.id })}
          >
            {sendNow.isPending ? "Sending…" : "Send now"}
          </Button>
        ) : null}
        {shown.state !== "cancelled" && direction.cancel?.allowed ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(
                { ...scope, executionId, messageId: direction.id },
                {
                  onSuccess: (result) => {
                    if (result.executions.find((item) => item.id === executionId)?.userDirections.find((item) => item.id === direction.id)?.state === "cancelled") setAcknowledgedCancellation(true);
                  },
                },
              )
            }
          >
            {cancel.isPending ? "Cancelling…" : "Cancel queued message"}
          </Button>
        ) : null}
      </div>
      {cancel.error && shown.state !== "cancelled" ? (
        <p className="team-direction-error" role="alert">
          {cancel.error.message}
        </p>
      ) : null}
      {sendNow.error && shown.state === "pending" ? (
        <p className="team-direction-error" role="alert">
          {sendNow.error.message}
        </p>
      ) : null}
    </div>
  );
}

function TeamPermissions({
  data,
  report,
  requested,
  mode,
  active,
  saving,
  failed,
  editing,
  refreshing,
  descriptionId,
  modeDescriptionId,
}: {
  data: TeamConversationData;
  report: TeamPermissionState | undefined;
  requested: PermissionPreset;
  mode: RunMode;
  active: boolean;
  saving: boolean;
  failed: boolean;
  editing: Partial<TeamPolicy> | null;
  refreshing: boolean;
  descriptionId: string;
  modeDescriptionId: string;
}) {
  const kind = teamPermissionStatus({ state: report, requested, mode, active, saving: saving && editing?.permissionMode !== undefined, failed, refreshing });
  const modeKind = teamModeStatus({ state: report, requested: mode, active, saving: saving && editing?.mode !== undefined, failed, refreshing });
  const counts = teamPermissionCounts(report);
  const current = counts.map(({ permission, count }) => `${permissionLabel[permission]}${counts.length > 1 ? ` (${count})` : ""}`).join(", ");
  const selected = permissionLabel[requested];
  const nextPermission = mode === "plan" ? permissionLabel.review : selected;
  const text = teamPermissionStatusText({ kind, selected, nextPermission, current });
  const modeLabel = { plan: "Plan", act: "Act" };
  const modes = teamModeCounts(report);
  const currentModes = modes.map(({ mode, count }) => `${modeLabel[mode]}${modes.length > 1 ? ` (${count})` : ""}`).join(", ");
  const modeText = teamModeStatusText({ kind: modeKind, selected: modeLabel[mode], current: currentModes });
  const permissionVisible = kind !== "current" && kind !== "next";
  const modeVisible = modeKind !== "current" && modeKind !== "next";
  const visible = permissionVisible || modeVisible;
  const details = Boolean(report?.runs.length) && visible;
  const uncertain = [kind, modeKind].some((value) => ["saving", "unconfirmed", "checking"].includes(value));
  return (
    <div className={visible ? "team-permission-status" : "sr-only"} data-team-permissions={kind}>
      <p id={modeDescriptionId} className={modeVisible ? undefined : "sr-only"} data-team-mode={modeKind} role="status">
        {modeText}
      </p>
      <p id={descriptionId} className={permissionVisible ? undefined : "sr-only"} role="status">
        {text}
      </p>
      {details ? (
        <details className="team-permission-details">
          <summary>{uncertain ? "Last reported agent mode and permissions" : "Agent mode and permissions"}</summary>
          <ul>
            {report!.runs.map((run) => {
              const actor = data.executions.flatMap((execution) => execution.actors).find((item) => item.runIds.includes(run.runId));
              const name = data.revision.members.find((member) => member.key === actor?.memberKey)?.name ?? "Agent";
              return (
                <li key={run.runId} data-team-permission-run={run.runId}>
                  <span>
                    {name}
                    {actor?.parentId && !actor.participant ? ` · ${actor.title}` : ""}
                  </span>
                  <span>
                    {modeLabel[run.mode]} · {permissionLabel[run.effective]}
                    {run.pendingRestart ? ` · ${permissionLabel[report?.mode?.requested === "plan" ? "review" : run.requested]} after this agent finishes` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** One attributed card per isolated assignment, even across multiple provider attempts. */
function TeamMemberCard({
  actor,
  execution,
  revision,
  threadId,
  project,
  checkpoints,
  initiallyOpen = false,
}: {
  actor: TeamActorView;
  execution: TeamExecutionView;
  revision: TeamRevision;
  threadId: string;
  project: Project;
  checkpoints: TeamContextCheckpoint[];
  initiallyOpen?: boolean;
}) {
  const member = revision.members.find((candidate) => candidate.key === actor.memberKey)!;
  const parent = execution.actors.find((candidate) => candidate.id === actor.parentId);
  const manager = revision.members.find((candidate) => candidate.key === parent?.memberKey);
  const groups = teamActivityGroups(execution, actor);
  const hasChildren = groups.some((group) => group.actors.length > 0);
  const model = useModelEffortLabel(actor.settings);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const stateDescriptionId = useId();
  const histories = useRuns(actor.runIds);
  const pending = histories.some((history) => history?.pendingApprovals);
  const lastMessage = histories.flatMap((history) => history?.blocks ?? []).findLast((block) => block.kind === "message" && block.role === "assistant" && block.text.trim());
  const summary = lastMessage?.kind === "message" ? lastMessage.text : actor.result;
  const hasReasoning = histories.some((history) => history?.blocks.some((block) => block.kind === "thinking" && block.text.trim()));
  // Own transcripts stay mounted while collapsed so approvals hydrate. Direct
  // assignments stay visible independently of the manager's disclosure.
  return (
    <section className="team-member" data-team-actor={actor.id} data-team-parent={actor.parentId ?? undefined} data-team-member={actor.memberKey}>
      <button
        type="button"
        className="team-member-toggle"
        aria-expanded={expanded}
        aria-describedby={stateDescriptionId}
        aria-label={`${expanded ? "Hide" : "Show"} activity for ${member.name}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown size={14} className={expanded ? "" : "team-chevron-closed"} />
        <TeamMemberPicture memberKey={actor.memberKey} size="sm" />
        <span className="team-member-identity">
          <strong>{member.name}</strong>
          <span>{model}</span>
          {manager ? <span>Delegated by {manager.name}</span> : null}
        </span>
        <span id={stateDescriptionId} className="team-member-state" data-state={pending || actor.modeHold ? "waiting" : actor.state}>
          {teamActorStateLabel({ pending: Boolean(pending), heldForPlan: actor.modeHold === "plan", stateLabel: stateLabel[actor.state] })}
        </span>
      </button>
      {actor.claims?.length ? (
        <p
          className="team-member-files"
          title={
            actor.claims
              .map((claim) => claim.note)
              .filter(Boolean)
              .join("\n") || undefined
          }
          data-team-claims={actor.claims.map((claim) => claim.path).join(",")}
        >
          Holding: <code>{teamFileList(actor.claims.map((claim) => claim.path))}</code>
        </p>
      ) : null}
      <div className="team-member-assignment">{actor.title}</div>
      {actorContextCheckpoints(checkpoints, execution.id, actor.id).map((checkpoint) => (
        <ContextNotice key={checkpoint.id} checkpoint={checkpoint} actorName={member.name} />
      ))}
      {!expanded && summary ? <p className="team-member-summary">{summary}</p> : null}
      {pending && !expanded ? (
        <Button size="sm" onClick={() => setExpanded(true)}>
          View request from {member.name}
        </Button>
      ) : null}
      <div hidden={!expanded} className="team-member-content">
        <p className="team-member-responsibility">{member.responsibility}</p>
      </div>
      {groups.map((group, index) => (
        <div key={group.id} data-team-owner={actor.id}>
          {group.runId ? (
            <div hidden={!expanded} className="team-member-content">
              {hasChildren && index > 0 ? <p className="team-member-continuation">{member.name} continued</p> : null}
              <ThreadMedia scopeKey={group.runId} basePath={actor.workspace?.path ?? project.rootPath} fileScope={actor.taskId ? { kind: "task", id: actor.taskId } : { kind: "thread", id: threadId }}>
                <RunActivity runId={group.runId} />
              </ThreadMedia>
              <RunChangedFiles run={actor.runs.find((run) => run.id === group.runId)} threadId={threadId} executionId={execution.id} />
            </div>
          ) : null}
          {group.actors.length ? (
            <div className="team-member-children" aria-label={`Assignments delegated by ${member.name}`}>
              {group.actors.map((child) => (
                <TeamMemberCard key={child.id} actor={child} execution={execution} revision={revision} threadId={threadId} project={project} checkpoints={checkpoints} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <div hidden={!expanded} className="team-member-content">
        {<TeamActorExplanation actor={actor} hasReasoning={hasReasoning} />}
        {actor.result ? (
          <div className="team-member-result">
            <strong>{hasChildren ? `${member.name}’s result` : "Result"}</strong>
            <p>{actor.result}</p>
          </div>
        ) : null}
        {actor.taskId ? (
          <Button size="sm" variant="ghost" onClick={() => openTask(actor.taskId!)}>
            Open assignment
          </Button>
        ) : null}
      </div>
      <ActorRecovery actor={actor} execution={execution} threadId={threadId} />
    </section>
  );
}

function ActorRecovery({ actor, execution, threadId }: { actor: TeamActorView; execution: TeamExecutionView; threadId: string }) {
  const retry = useRpcMutation("orchestration.retry");
  const fresh = useRpcMutation("orchestration.retry");
  const retrySetup = useRpcMutation("orchestration.workspace.retrySetup");
  const acceptSetup = useRpcMutation("orchestration.workspace.acceptSetup");
  const scope = useTeamControl(threadId);
  const target = { ...scope, executionId: execution.id, actorId: actor.id };
  const freshRequest = useTeamContextAction(`conversation.${threadId}.context.fresh.${execution.id}.${actor.id}`, (requestKey) => fresh.mutateAsync({ ...target, fresh: true, requestKey }));
  const setupRetry = useTeamContextAction(`conversation.${threadId}.setup.retry.${execution.id}.${actor.id}`, (requestKey) => retrySetup.mutateAsync({ ...target, requestKey }));
  const setupAccept = useTeamContextAction(`conversation.${threadId}.setup.accept.${execution.id}.${actor.id}`, (requestKey) => acceptSetup.mutateAsync({ ...target, requestKey }));
  const recovery = actor.workspace?.recovery;
  const needsRecovery = actor.state === "attention" || Boolean(actor.workspace?.error);
  const pendingRequest = freshRequest.pending || setupRetry.pending || setupAccept.pending;
  if (!needsRecovery && !pendingRequest) return null;
  const busy = retry.isPending || freshRequest.working || setupRetry.working || setupAccept.working;
  const showFresh = Boolean(actor.freshRetry) || Boolean(freshRequest.pending);
  const showSetupRetry = Boolean(recovery) || Boolean(setupRetry.pending);
  const showSetupAccept = Boolean(recovery?.sourceChanged) || Boolean(setupAccept.pending);
  const reasons = disallowedReasons([
    [needsRecovery, actor.retry, null],
    [showFresh, actor.freshRetry, freshRequest.pending],
    [showSetupRetry, recovery?.retrySetup, setupRetry.pending],
    [showSetupAccept, recovery?.acceptSetup, setupAccept.pending],
  ]);
  return (
    <div className="team-recovery" role="status">
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        <p>{needsRecovery ? (actor.error ?? actor.workspace?.error ?? "This assignment needs attention.") : "A saved recovery request is awaiting confirmation."}</p>
      </div>
      <div className="team-recovery-actions">
        {needsRecovery ? (
          <Button size="sm" disabled={!actor.retry.allowed || busy} title={actor.retry.reason ?? undefined} onClick={() => retry.mutate(target)}>
            {retry.isPending ? "Retrying…" : "Retry assignment"}
          </Button>
        ) : null}
        {showFresh ? (
          <DurableActionButton request={freshRequest} availability={actor.freshRetry} busy={busy} labels={["Start fresh session", "Retry fresh session request", "Starting fresh…"]} />
        ) : null}
        {showSetupRetry ? <DurableActionButton request={setupRetry} availability={recovery?.retrySetup} busy={busy} labels={["Retry setup", "Retry saved setup request", "Retrying setup…"]} /> : null}
        {showSetupAccept ? (
          <DurableActionButton request={setupAccept} availability={recovery?.acceptSetup} busy={busy} labels={["Accept setup changes", "Retry saved acceptance", "Accepting…"]} />
        ) : null}
        {actor.workspace ? (
          <Button size="sm" variant="ghost" onClick={() => window.openorc.revealFile(actor.workspace!.path)}>
            <Folder size={13} />
            Open workspace
          </Button>
        ) : null}
      </div>
      {showFresh ? <p className="text-xs text-ink-3">A fresh session uses a short local handoff. History and files are kept.</p> : null}
      {recovery ? (
        <p className="text-xs text-ink-3">
          {recovery.sourceChanged
            ? "Setup changed source files. Accepting uses the prepared files as this assignment’s input; the assignment’s result is measured from them."
            : "Retry setup prepares the same captured input in a new directory. The failed directory is kept."}
        </p>
      ) : null}
      {recovery ? <RetiredDirectories label="Earlier setup directories kept" paths={recovery.retiredPaths} /> : null}
      {reasons.map((reason) => (
        <p key={reason} className="text-xs text-ink-3">
          {reason}
        </p>
      ))}
      {retry.error ? (
        <p role="alert" className="text-sm text-bad">
          {retry.error.message}
        </p>
      ) : null}
      {[freshRequest, setupRetry, setupAccept].map((request, index) =>
        request.error ? (
          <p key={index} role="alert" className="text-sm text-bad">
            {request.error}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** A retained publication that has not been applied, with its explicit recovery controls. */
function PublicationRecovery({ receipt, executionId, threadId }: { receipt: TeamExecutionView["publications"][number]; executionId: string; threadId: string }) {
  const retry = useRpcMutation("orchestration.integration.retry");
  const accept = useRpcMutation("orchestration.integration.accept");
  const scope = useTeamControl(threadId);
  const target = { ...scope, executionId, publicationId: receipt.id };
  const retryRequest = useTeamContextAction(`conversation.${threadId}.integration.retry.${receipt.id}`, (requestKey) => retry.mutateAsync({ ...target, requestKey }));
  const acceptRequest = useTeamContextAction(`conversation.${threadId}.integration.accept.${receipt.id}`, (requestKey) => accept.mutateAsync({ ...target, requestKey }));
  const recovery = receipt.recovery;
  const conflict = receipt.state === "conflict";
  const busy = retryRequest.working || acceptRequest.working;
  const showRetry = Boolean(recovery) || Boolean(retryRequest.pending);
  const showAccept = (Boolean(recovery) && conflict) || Boolean(acceptRequest.pending);
  const reasons = disallowedReasons([
    [showRetry, recovery?.retry, retryRequest.pending],
    [showAccept, recovery?.accept, acceptRequest.pending],
  ]);
  const conflicts = recovery?.conflicts ?? [];
  return (
    <div className="team-recovery" role="status" data-team-publication={receipt.id} data-publication-state={receipt.state}>
      <strong>{conflict ? "Changes need review" : "Integration needs attention"}</strong>
      <p>{receipt.error ?? "The result is retained until integration can finish."}</p>
      {conflicts.length ? (
        <p className="text-xs text-ink-3">
          Conflicts: {conflicts.slice(0, 5).join(", ")}
          {conflicts.length > 5 ? ` +${conflicts.length - 5} more` : ""}
        </p>
      ) : null}
      <div className="team-recovery-actions">
        {showRetry ? (
          <DurableActionButton request={retryRequest} availability={recovery?.retry} busy={busy} labels={["Retry integration", "Retry saved integration request", "Retrying integration…"]} />
        ) : null}
        {showAccept ? <DurableActionButton request={acceptRequest} availability={recovery?.accept} busy={busy} labels={["Accept resolved changes", "Retry saved acceptance", "Accepting…"]} /> : null}
        <Button size="sm" variant={showRetry || showAccept ? "ghost" : "secondary"} onClick={() => window.openorc.revealFile(receipt.scratchPath)}>
          <Folder size={13} />
          Open retained integration
        </Button>
      </div>
      {recovery ? <p className="text-xs text-ink-3">Resolve the files in the retained integration, then accept. Retry merges the current workspaces again into a new scratch directory.</p> : null}
      {recovery ? <RetiredDirectories label="Earlier integration directories kept" paths={recovery.retiredScratchPaths} /> : null}
      {reasons.map((reason) => (
        <p key={reason} className="text-xs text-ink-3">
          {reason}
        </p>
      ))}
      {[retryRequest, acceptRequest].map((request, index) =>
        request.error ? (
          <p key={index} role="alert" className="text-sm text-bad">
            {request.error}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** One durable action: disabled when disallowed unless a saved request still needs confirming. */
function DurableActionButton({
  request,
  availability,
  busy,
  labels: [label, pendingLabel, workingLabel],
}: {
  request: ReturnType<typeof useTeamContextAction>;
  availability: TeamActionAvailability | undefined;
  busy: boolean;
  labels: [idle: string, pending: string, working: string];
}) {
  const disallowed = !request.pending && !availability?.allowed;
  return (
    <Button size="sm" disabled={busy || disallowed} title={disallowed ? (availability?.reason ?? undefined) : undefined} onClick={request.run}>
      {durableActionLabel({ working: request.working, pending: Boolean(request.pending), labels: [label, pendingLabel, workingLabel] })}
    </Button>
  );
}

/** Reasons for the shown, disallowed actions without a pending request, each once. */
function disallowedReasons(actions: Array<[shown: boolean, availability: TeamActionAvailability | undefined, pending: string | null]>): string[] {
  const reasons = actions.flatMap(([shown, availability, pending]) => (shown && !pending && availability && !availability.allowed && availability.reason ? [availability.reason] : []));
  return [...new Set(reasons)];
}

function RetiredDirectories({ label, paths }: { label: string; paths: string[] }) {
  if (!paths.length) return null;
  const shown = paths.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
      <span>
        {label}: {paths.length}
      </span>
      {shown.map((path) => (
        <Button key={path} size="sm" variant="ghost" title={path} onClick={() => window.openorc.revealFile(path)}>
          <Folder size={13} />
          Open
        </Button>
      ))}
      {paths.length > shown.length ? <span>+{paths.length - shown.length} more</span> : null}
    </div>
  );
}

/** The request survives an uncertain reply; confirming it never starts a second session. */
function useTeamContextAction(storageKey: string, invoke: (requestKey: string) => Promise<unknown>) {
  const [pending, setPending] = useState(() => readTeamContextRequest(storageKey));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError(null);
    void (async () => {
      try {
        const key = beginTeamContextRequest(storageKey, pending);
        setPending(key);
        await invoke(key);
        if (finishTeamContextRequest(storageKey, key)) setPending(null);
        else setError("The context request succeeded, but its local recovery record could not be cleared. Retry the saved request when local storage is available.");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        inFlight.current = false;
        setWorking(false);
      }
    })();
  };
  return { pending, working, error, run };
}

function ContextNotice({ checkpoint, actorName }: { checkpoint: TeamContextCheckpoint; actorName: string }) {
  return (
    <div className="team-context-notice" data-team-context-checkpoint={checkpoint.id} data-team-context-reason={checkpoint.reason} data-team-context-actor={checkpoint.actorId}>
      <div>
        <strong>{checkpoint.reason === "compact" ? `${actorName} context compacted` : `Fresh context saved for ${actorName}`}</strong>
        <time dateTime={new Date(checkpoint.createdAt).toISOString()}>{new Date(checkpoint.createdAt).toLocaleString()}</time>
      </div>
      <p>Local handoff saved. History and files kept.</p>
    </div>
  );
}

/** Live activity stays attached to the current turn, including reused provider processes. */
function TeamActivityStrip({ execution, revision }: { execution: TeamExecutionView; revision: TeamRevision }) {
  const runs = useRunMap(execution.actors.flatMap((actor) => (actor.activeRunId ? [actor.activeRunId] : [])));
  return (
    <ul className="team-activity-strip" aria-label="Team activity">
      {execution.actors
        .filter((actor) => actor.state !== "completed" && actor.state !== "cancelled")
        .map((actor) => {
          const transcript = actor.activeRunId ? runs.get(actor.activeRunId) : undefined;
          const turn = actor.runs.at(-1)?.turn;
          const blocks = transcript?.blocks.filter((block) => (transcript.turnOf.get(block.id) ?? 0) === turn) ?? [];
          const status = teamMemberActivity(actor, blocks);
          return (
            <li key={actor.id} title={actor.error ?? actor.waitReason ?? status}>
              <strong>{revision.members.find((member) => member.key === actor.memberKey)?.name ?? actor.title}</strong>
              <span>{status}</span>
            </li>
          );
        })}
    </ul>
  );
}

/** Shared-workspace files a turn changed. Older turns and isolated assignments carry no list. */
function RunChangedFiles({ run, threadId, executionId }: { run: TeamActorView["runs"][number] | undefined; threadId: string; executionId: string }) {
  const scope = useTeamControl(threadId);
  if (!run?.changedFiles?.length) return null;
  return <TeamChangeCard scope={{ ...scope, executionId, turnId: run.turnId }} paths={run.changedFiles} />;
}

function RunActivity({ runId, turn, fork, live, ambient = false, author }: { author?: string; live?: boolean; ambient?: boolean; runId: string; turn?: number; fork?: TeamForkControls | undefined }) {
  const transcript = useRun(runId);
  const showActivity = useContext(TeamActivityVisibility);
  const attention = useContext(TeamAttentionTarget);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void hydrate(runId).catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [runId]);
  useEffect(() => {
    if (!getRun(runId)?.hydrated) load();
  }, [runId, load]);
  // User direction is rendered once from the execution journal, as its own feed item.
  // A conversation member's process serves several turns; a turn shows only the blocks recorded during it.
  const blocks = teamRunBlocks(turn === undefined || !transcript ? (transcript?.blocks ?? []) : transcript.blocks.filter((block) => (transcript.turnOf.get(block.id) ?? 0) === turn));
  const replyId = fork && transcript?.hydrated ? teamForkReplyId(transcript.blocks) : null;
  const replyAction = fork && replyId ? { blockId: replyId, content: <TeamReplyFork runId={runId} fork={fork} /> } : undefined;
  function renderActivityState() {
    if (error)
      return (
        <p role="alert" className="text-sm text-bad">
          Could not load agent activity.{" "}
          <TextButton underline onClick={load}>
            Retry
          </TextButton>
        </p>
      );
    if (showActivity && !transcript?.hydrated && !blocks.length) return <p className="text-xs text-ink-3">Loading activity…</p>;
    return null;
  }
  return (
    <div data-team-run={runId}>
      {blocks.length ? (
        <TeamWorkTranscript
          runId={runId}
          blocks={blocks}
          live={live ?? transcript?.live ?? false}
          ambient={ambient}
          author={author}
          taskCards={false}
          showActivity={showActivity}
          pendingApproval={
            attention
              ? (block) => (
                  <div data-team-request={`approval:${runId}:${block.approvalId}`}>
                    <p className="text-base text-ink-2 whitespace-pre-wrap">{teamRequestSummary(block)}</p>
                    <TextButton
                      className="text-sm text-ink-3"
                      onClick={() => {
                        attention.select(`approval:${runId}:${block.approvalId}`);
                        const target = document.getElementById(attention.id);
                        target?.focus();
                      }}
                    >
                      Respond above the composer
                    </TextButton>
                  </div>
                )
              : undefined
          }
          replyAction={replyAction}
        />
      ) : null}
      {renderActivityState()}
    </div>
  );
}

function TeamReplyFork({ runId, fork }: { runId: string; fork: TeamForkControls }) {
  const descriptionId = useId();
  const reason = fork.reasonFor(runId);
  const saved = fork.pending?.upToRunId === runId;
  const error = replyForkError(fork, runId, saved);
  const description = reason ?? teamReplyForkDescription({ mutating: fork.mutating, saved });
  return (
    <div className="mt-2 text-xs text-ink-3" data-team-reply-fork={runId}>
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip label={description}>
          <Button size="sm" variant="ghost" aria-describedby={descriptionId} disabled={Boolean(reason) || fork.mutating} onClick={() => void fork.run(runId)}>
            <GitFork size={13} />
            {durableActionLabel({ working: fork.working && saved, pending: saved, labels: ["Fork from this reply", "Retry fork from this reply", "Forking…"] })}
          </Button>
        </Tooltip>
        {fork.needsRefresh ? (
          <Button size="sm" variant="ghost" disabled={fork.mutating || fork.refreshing} onClick={fork.refresh}>
            Refresh team status
          </Button>
        ) : null}
      </div>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      {error ? (
        <p className="mt-1 text-bad break-words" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TeamTaskConversation({ task, project, data }: { task: Task; project: Project; data: TeamConversationData }) {
  const state = useRpc("orchestration.taskState", { taskId: task.id });
  const fork = useTeamFork(data.instance.threadId, true, task.id);
  if (!state.data)
    return (
      <div className="p-6 text-sm text-ink-3">
        {state.isPending ? "Loading team task…" : "Could not confirm this team task."}
        {!state.isPending ? (
          <Button size="sm" className="ml-2" onClick={() => void state.refetch()}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  const view = state.data;
  const renderedRuns = new Set<string>();
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="max-w-chat mx-auto">
        <TeamTaskStart key={task.id} task={view} />
        {state.error ? (
          <p role="alert" className="text-sm text-bad mt-3">
            Task activity could not refresh.{" "}
            <TextButton underline onClick={() => void state.refetch()}>
              Retry
            </TextButton>
          </p>
        ) : null}
        <div className="mt-4">
          <TeamTaskAdmissions task={view} />
        </div>
        {view.assignments.map((assignment, index) => {
          const member = view.members.find((item) => item.key === assignment.memberKey);
          const execution = data.executions.find((item) => item.id === assignment.executionId);
          const actor = execution?.actors.find((item) => item.id === assignment.actorId);
          const runIds = assignment.runIds.filter((id) => {
            if (renderedRuns.has(id)) return false;
            renderedRuns.add(id);
            return true;
          });
          function renderAssignmentExplanation() {
            if (actor?.modeHold === "plan") return <p className="text-sm text-ink-3">Switch to Act to continue this assignment.</p>;
            if (!runIds.length) return <p className="text-sm text-ink-3">{assignment.result ?? "Activity appears when the agent starts."}</p>;
            return null;
          }
          return (
            <section key={`${assignment.executionId}:${assignment.actorId}`} className="mt-5 border-t border-line pt-4" data-team-task-assignment={`${assignment.executionId}:${assignment.actorId}`}>
              <h2 className="text-base font-medium mb-3">
                {member?.name ?? "Agent"}
                {index > 0 ? " · Follow-up" : ""} <span className="text-ink-3 font-normal">· {actor?.modeHold === "plan" ? "Waiting for Act" : stateLabel[assignment.state]}</span>
              </h2>
              {runIds.map((runId) => (
                <ThreadMedia
                  key={runId}
                  scopeKey={runId}
                  basePath={actor?.workspace?.path ?? task.worktreePath ?? project.rootPath}
                  fileScope={assignment.actorId === "lead" ? { kind: "thread", id: view.threadId } : { kind: "task", id: task.id }}
                >
                  <RunActivity runId={runId} fork={assignment.actorId === "lead" ? fork : undefined} />
                </ThreadMedia>
              ))}
              {renderAssignmentExplanation()}
              {actor && execution ? <ActorRecovery actor={actor} execution={execution} threadId={view.threadId} /> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function replyForkError(fork: TeamForkControls, runId: string, saved: boolean): string | null {
  if (fork.failure?.upToRunId === runId) return fork.failure.message;
  return saved ? fork.recoveryError : null;
}

import { conversationWorkspaceMode, conversationLocation, conversationEmptyHint, conversationEmptyTitle, workspaceDestination } from "../lib/conversation-status-presentation";
import { WORKSPACE_ID } from "@openorc/protocol";
import { TaskForwarding } from "./TaskForwarding";
import { useCallback, useMemo, useState } from "react";
import { defaultHarnessId, harnessShortName, type AgentKind, type Project, type Run, type Task, type ThreadSummary, type WorkspaceMode } from "@openorc/protocol";
import { AlertCircle, GitBranch, Laptop } from "./icons";
import { Composer, type SlashCommand } from "./Composer";
import { ComposerChoice } from "./ComposerChoice";
import { Transcript } from "./Transcript";
import { MessageQueue } from "./MessageQueue";
import { BackgroundCommands } from "./BackgroundCommands";
import { useTurnFooter } from "./TurnFooter";
import { conversationActivity, conversationPlaceholder, conversationSteerReason, conversationSendDisabledReason, messageBody, processFit, type SubmitRequest } from "@openorc/client";
import { useComposerChanges } from "../lib/composer-changes";
import { useProjectGit } from "../lib/project-git";
import { Button, Empty } from "./ui";
import { useConversationSettings, useConversationTranscript, useRpc, useRpcMutation, useSubmit } from "../lib/client";
import { useConversationDraft } from "../lib/conversation-draft";
import { openThread, useRouter, type MessageTarget } from "../lib/router";
import { useSkillCommands } from "../lib/skill-commands";
import { useTurnFooters } from "../lib/turn-footers";
import { TeamConversation, TeamTaskConversation } from "./TeamConversation";
import { useOrclingConversation } from "./useOrclingConversation";
import { ConversationVoice } from "../lib/turn-authors";

export type ConversationScope = { kind: "task"; task: Task } | { kind: "thread"; thread: ThreadSummary };

/**
 * The chat over a task's or a thread's runs, shown as one continuous
 * transcript. The composer continues the live session when there is one,
 * queues while the agent is busy, and otherwise starts a run that resumes
 * the agent's last session. Thread drafts survive leaving the screen.
 */
export function Conversation({ scope, project, toolbarTarget }: { scope: ConversationScope; project: Project; toolbarTarget?: HTMLElement | null }) {
  const pinned = scope.kind === "thread" && Boolean(scope.thread.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: scope.kind === "thread" ? scope.thread.id : "" }, { enabled: pinned });
  if (scope.kind === "task" && scope.task.threadId) return <OwnedTaskConversation task={scope.task} project={project} />;
  if (pinned && (runtime.isPending || !runtime.data))
    return (
      <div className="p-6 text-sm text-ink-3">
        {runtime.isPending ? "Loading team activity…" : "Could not load team activity."}
        {runtime.isError || (!runtime.isPending && !runtime.data) ? (
          <Button size="sm" className="ml-2" onClick={() => void runtime.refetch()}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  if (runtime.data && pinned && scope.kind === "thread")
    return (
      <TeamConversation
        thread={scope.thread}
        project={project}
        data={runtime.data}
        refresh={() => void runtime.refetch()}
        refreshError={runtime.error?.message ?? null}
        toolbarTarget={toolbarTarget}
      />
    );
  return scope.kind === "task" ? (
    <TaskForwarding task={scope.task}>
      <IndividualConversation scope={scope} project={project} />
    </TaskForwarding>
  ) : (
    <IndividualConversation scope={scope} project={project} />
  );
}

/** Check saved-task ownership before choosing its activity endpoint. A hidden
 * owner must never look like an ordinary task after a failed or missing read. */
function OwnedTaskConversation({ task, project }: { task: Task; project: Project }) {
  const ownership = useRpc("orchestration.taskState", { taskId: task.id });
  const retained = Boolean(ownership.data?.ownerDeletedAt);
  const runtime = useRpc("orchestration.runtime", { threadId: task.threadId! }, { enabled: Boolean(ownership.data) && !retained });
  const taskRuntime = useRpc("orchestration.taskRuntime", { taskId: task.id }, { enabled: retained });
  if (ownership.isPending || ownership.isError)
    return (
      <div className="p-6 text-sm text-ink-3">
        {ownership.isPending ? "Loading team activity…" : "Could not check task ownership."}
        {ownership.isError ? (
          <Button size="sm" className="ml-2" onClick={() => void ownership.refetch()}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  if (!ownership.data) return <IndividualConversation scope={{ kind: "task", task }} project={project} />;
  const selected = retained ? taskRuntime : runtime;
  if (selected.isPending || !selected.data)
    return (
      <div className="p-6 text-sm text-ink-3">
        {selected.isPending ? "Loading team activity…" : "Could not load team activity."}
        {!selected.isPending ? (
          <Button size="sm" className="ml-2" onClick={() => void selected.refetch()}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  if (retained && taskRuntime.data)
    return (
      <TaskForwarding task={task} team>
        <TeamConversation
          key={`retained:${task.id}`}
          retainedTaskId={task.id}
          thread={taskRuntime.data.thread}
          project={project}
          data={taskRuntime.data.runtime}
          refresh={() => void taskRuntime.refetch()}
          refreshError={taskRuntime.error?.message ?? null}
        />
      </TaskForwarding>
    );
  return runtime.data ? (
    <TaskForwarding task={task} team>
      <TeamTaskConversation task={task} project={project} data={runtime.data} />
    </TaskForwarding>
  ) : null;
}

/**
 * The checkout a conversation works in, read only where the project folder has git: the branch a local checkout
 * publishes, which the agent may switch mid-conversation, and its uncommitted changes.
 */
function useCheckout(thread: ThreadSummary | null, project: Project) {
  const git = useProjectGit(project.id);
  const checkout = useRpc("git.threadPushState", { threadId: thread?.id ?? "" }, { enabled: Boolean(thread) && git.tracks && thread?.workspaceMode === "current", refetchInterval: 8000 });
  const changes = useComposerChanges(thread && git.tracks ? { kind: "thread", id: thread.id, projectName: project.name, thread } : null);
  return { checkout, changes, git };
}

/** The message the route opened this conversation at, such as a search result; only the focused conversation has one. */
function useMessageTarget(scope: ConversationScope): MessageTarget | undefined {
  return useRouter(({ route }) => {
    if (route.view === "thread" && scope.kind === "thread" && route.threadId === scope.thread.id) return route.message;
    if (route.view === "task" && scope.kind === "task" && route.taskId === scope.task.id) return route.message;
    return undefined;
  });
}

function IndividualConversation({ scope, project }: { scope: ConversationScope; project: Project }) {
  const runsQuery = useRpc(scope.kind === "task" ? "runs.listForTask" : "runs.listForThread", scope.kind === "task" ? { taskId: scope.task.id } : { threadId: scope.thread.id });
  const runs = runsQuery.data ?? [];
  const firstTaskRun = scope.kind === "task" && runs.length === 0;
  const forwarding = useRpc("tasks.forwarding", { taskId: scope.kind === "task" ? scope.task.id : "" }, { enabled: scope.kind === "task" });
  const forwardedFiles = Boolean(forwarding.data?.forwarding?.snapshot);
  const [selectedWorkspace, setWorkspace] = useState<WorkspaceMode | null>(null);
  const workspaceMode = conversationWorkspaceMode({ scope, firstTaskRun, selected: selectedWorkspace });
  const thread = scope.kind === "thread" ? scope.thread : null;
  const conversation = { kind: scope.kind, id: scope.kind === "thread" ? scope.thread.id : scope.task.id };
  const { checkout, changes: composerChanges, git } = useCheckout(thread, project);

  const activeRun: Run | undefined = runs[runs.length - 1];
  const basePath = (scope.kind === "task" ? scope.task.worktreePath : (scope.thread.workingDirectory ?? scope.thread.worktreePath)) ?? project.rootPath;
  const target = useMessageTarget(scope);
  const { merged, transcripts, liveTranscript, hasOlder, loadOlder } = useConversationTranscript({ runs, threadId: thread?.id ?? null, target });
  const footers = useTurnFooters({ threadId: thread?.id ?? null, transcripts, blocks: merged?.blocks, basePath });

  const settings = useConversationSettings({ thread, activeRun });
  const { choice, mode, permission, permissionReady, permissionError } = settings;
  const orclings = useOrclingConversation({ thread, runs, choice, onModel: settings.selectModel });
  const voice = useRunVoices(orclings.voice, runs, thread);
  const draftKey = `conversation.${conversation.id}`;
  const { prompt, setPrompt, clearDraft, error: draftError } = useConversationDraft({ draftKey, threadId: thread?.id ?? null, initialText: thread?.draft ?? "" });
  const submitter = useSubmit();
  const [sends, setSends] = useState(0);
  const unqueue = useRpcMutation("threads.unqueue");
  const sendQueued = useRpcMutation("threads.sendQueued");
  const stopCommand = useRpcMutation("threads.stopCommand");
  const compact = useRpcMutation("threads.compact");
  const fork = useRpcMutation("threads.fork");
  const forkThread = fork.mutate;
  const threadId = thread?.id;
  const forkConversation = useCallback(() => {
    if (threadId) forkThread({ id: threadId }, { onSuccess: (t) => void (!("rejected" in t) && openThread(t.id)) });
  }, [threadId, forkThread]);

  const { live, working, generatingImage } = conversationActivity({ thread, activeRun, liveTranscript, compacting: compact.isPending });
  const { sameAgent, settingsPending, canSteer } = processFit({ live, activeRun, choice, mode, permission, compacting: compact.isPending });
  const steerReason = conversationSteerReason({ canSteer, compacting: compact.isPending, settingsPending, sameAgent, agent: activeRun?.agent });
  const sendDisabledReason = conversationSendDisabledReason({ permissionReady, historyLoading: runsQuery.isLoading, historyFailed: Boolean(runsQuery.error), hasModel: Boolean(choice) });
  const busy = submitter.pending;
  const turnFooter = useTurnFooter({ footers, threadId, working });
  const switching = Boolean(thread && choice && runs.length > 0 && !runs.some((r) => r.agent === choice.agent));

  const request: Omit<SubmitRequest, "now"> = {
    target: scope.kind === "task" ? { kind: "task", taskId: scope.task.id, ...(firstTaskRun ? { workspaceMode } : {}) } : { kind: "thread", threadId: scope.thread.id },
    working,
    live,
    activeRun,
    agentsUsed: runs.map((r) => r.agent),
    choice,
    mode,
    permission,
    permissionReady,
    compacting: compact.isPending,
    waitForSave: settings.waitForSave,
  };
  const submit = async (text: string, attachments: string[], now: boolean) => {
    setSends((count) => count + 1);
    // A message to an Orcling goes to the Orcling, not to this conversation's agent.
    if (await orclings.ask(messageBody(text, attachments), attachments)) return clearDraft();
    await submitter.submit({ ...request, now }, { text, attachments });
    clearDraft();
  };
  const restart = () => submitter.submit({ ...request, now: false, restart: true }, { text: "Continue where you left off. Check the working tree first.", attachments: [] }).then(clearDraft);

  const skills = useSkillCommands(project.id, choice?.agent, thread?.workingDirectory);
  const commands: SlashCommand[] = [
    ...(thread
      ? [
          ...(!working ? [{ name: "compact", hint: "Fold the conversation so far into a summary", run: () => compact.mutate({ id: thread.id }) }] : []),
          { name: "plan", hint: "Switch this thread to plan mode", run: () => settings.selectMode("plan") },
          { name: "act", hint: "Switch this thread to act mode", run: () => settings.selectMode("act") },
          { name: "fork", hint: "Continue in a new thread from here", run: forkConversation },
        ]
      : []),
    ...skills,
  ];

  const location = conversationLocation({ scope, project, mode: workspaceMode, basePath, checkoutBranch: checkout.data?.branch, plainFolder: git.state === "none" });
  const emptyHint = conversationEmptyHint({ task: scope.kind === "task", workspace: project.id === WORKSPACE_ID });
  const session = thread?.session;
  const placeholder = conversationPlaceholder({ firstTaskRun, working, canSteer, agent: choice?.agent });

  function renderTranscript() {
    if (merged && merged.blocks.length > 0)
      return (
        <ConversationVoice.Provider value={voice}>
          <Transcript
            working={working}
            fileScope={conversation}
            basePath={basePath}
            run={merged}
            scrollKey={conversation.id}
            followKey={sends}
            onFork={thread ? forkConversation : undefined}
            hasOlder={hasOlder}
            onLoadOlder={loadOlder}
            reveal={target}
            trailing={turnFooter}
          />
        </ConversationVoice.Provider>
      );
    if (runsQuery.isLoading) return null;
    return orclings.empty ?? <Empty title={conversationEmptyTitle({ count: runs.length, firstTaskRun })}>{runs.length === 0 ? emptyHint : ""}</Empty>;
  }
  return (
    <div className="h-full min-w-0 flex flex-col min-h-0">
      <div className="flex-1 min-h-0 relative">{renderTranscript()}</div>
      <div className="composer-padding shrink-0 px-6 pb-6 pt-2">
        <div className="max-w-chat w-full min-w-0 mx-auto grid grid-cols-1 gap-2">
          {thread ? (
            <MessageQueue
              messages={thread.queued}
              canSend={canSteer}
              pending={sendQueued.isPending || unqueue.isPending}
              sendReason={steerReason}
              agentName={harnessShortName(thread.agent ?? defaultHarnessId)}
              onSend={(messageId) => {
                setSends((count) => count + 1);
                sendQueued.mutate({ id: thread.id, messageId });
              }}
              onRemove={(messageId) => unqueue.mutate({ id: thread.id, messageId })}
            />
          ) : null}
          {thread ? <BackgroundCommands commands={thread.backgroundCommands ?? []} pending={stopCommand.isPending} onStop={(commandId) => stopCommand.mutate({ id: thread.id, commandId })} /> : null}
          {session && !working ? <SessionRecovery session={session} agent={thread?.agent ?? defaultHarnessId} disabled={!choice || busy} onRestart={() => void restart().catch(() => {})} /> : null}
          {switching && choice ? (
            <div className="text-xs text-ink-3 px-1">Switching to {harnessShortName(choice.agent)} starts a fresh session. It gets a brief of this conversation, not the other agent's session.</div>
          ) : null}
          {settingsPending && activeRun && thread && activeRun.mode === "act" && permission === "autonomous" && activeRun.permissionMode !== permission ? (
            <div role="status" className="text-xs text-ink-3 px-1">
              {settings.error ? "Could not apply Autonomous. Select it again to retry." : "Applying Autonomous to the current turn…"}
            </div>
          ) : null}
          <Composer
            draftKey={`${draftKey}.attachments`}
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            placeholder={orclings.placeholder ?? placeholder}
            mentions={orclings.mentions}
            modelControl={orclings.modelControl}
            model={choice}
            onModel={settings.selectModel}
            onExecutionMode={settings.selectExecutionMode}
            mode={mode}
            onMode={settings.selectMode}
            permission={permission}
            onPermission={settings.selectPermission}
            location={location}
            hasStarted={thread?.hasStarted ?? (runs.length > 0 || Boolean(thread?.forkedAtRunId))}
            changes={composerChanges}
            busy={busy}
            allowEmpty={firstTaskRun}
            disabledReason={sendDisabledReason}
            live={live && activeRun ? { runId: activeRun.id, working } : null}
            queueing={Boolean(thread && working)}
            liveByDefault
            steerable={canSteer}
            steerReason={steerReason}
            context={thread?.context ?? null}
            compacting={compact.isPending}
            generatingImage={generatingImage}
            onCompact={thread && !working ? () => compact.mutate({ id: thread.id }) : undefined}
            compactDisabledReason={working ? "Available after this turn finishes." : undefined}
            fileSearch={conversation}
            commands={commands}
            error={(submitter.error ?? sendQueued.error ?? stopCommand.error ?? compact.error ?? unqueue.error ?? fork.error ?? settings.error ?? draftError)?.message ?? permissionError}
          >
            {firstTaskRun && scope.kind === "task" ? (
              <ComposerChoice
                ariaLabel="Where the task works"
                value={workspaceMode}
                options={[
                  { value: "current" as const, label: "Checkout", hint: project.rootPath, icon: Laptop },
                  {
                    value: "worktree" as const,
                    label: "Worktree",
                    hint: scope.task.worktreePath ?? `New isolated worktree from ${scope.task.baseRef ?? project.defaultBranch ?? "HEAD"}`,
                    icon: GitBranch,
                  },
                ]}
                onChange={setWorkspace}
                disabled={busy || forwardedFiles || Boolean(scope.task.worktreePath) || !runsQuery.data}
              />
            ) : null}
          </Composer>
          {firstTaskRun ? (
            <p
              className="px-1 text-xs text-ink-3 truncate"
              title={workspaceDestination({ mode: workspaceMode, rootPath: project.rootPath, taskPath: scope.kind === "task" ? scope.task.worktreePath : null })}
            >
              {workspaceDestination({ mode: workspaceMode, rootPath: project.rootPath, taskPath: scope.kind === "task" ? scope.task.worktreePath : null })}
            </p>
          ) : null}
          {runsQuery.error ? (
            <Button size="sm" variant="ghost" onClick={() => void runsQuery.refetch()}>
              Retry loading agent history
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Each run's agent and model for the turn heads, with the thread's own for messages saved without a run. */
function useRunVoices(voice: ConversationVoice, runs: readonly Run[], thread: ThreadSummary | null): ConversationVoice {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  return useMemo(() => {
    const named = (agent: string, model: string | null) => ({ agent, model: model ? (models.data?.find((option) => option.agent === agent && option.id === model)?.label ?? model) : null });
    return {
      ...voice,
      runs: new Map(runs.map((run) => [run.id, named(run.agent, run.model)])),
      agent: thread ? named(thread.agent, thread.model) : undefined,
    };
  }, [voice, runs, thread, models.data]);
}

/** A lost session or a failed last turn, with a fresh start that hands the conversation over. */
function SessionRecovery({ session, agent, disabled, onRestart }: { session: NonNullable<ThreadSummary["session"]>; agent: AgentKind; disabled: boolean; onRestart: () => void }) {
  if (session.status !== "lost" && session.status !== "error") return null;
  return (
    <div data-blocking="true" className="rounded-xl bg-bad-soft px-4 py-3 text-base">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={16} className="text-bad mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 grid gap-2">
          <div className="text-ink">{session.status === "lost" ? `${harnessShortName(agent)} no longer has this session.` : "The last turn failed."}</div>
          {session.message ? <div className="text-ink-2 whitespace-pre-wrap break-words max-h-24 overflow-auto">{session.message}</div> : null}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={disabled} onClick={onRestart}>
              {session.status === "lost" ? "Start a fresh session with a handoff" : "Retry with a fresh session"}
            </Button>
            {session.status === "error" ? <span className="text-xs text-ink-2">Or send a message to resume.</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

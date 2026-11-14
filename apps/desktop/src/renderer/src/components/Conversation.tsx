import { useComposerChanges } from "../lib/composer-changes";
import { useHostedComposerChanges } from "../lib/hosted-composer-changes";
import { useProjectGit } from "../lib/project-git";
import {
  cloudTurnOf,
  CONTINUE_PROMPT,
  conversationActivity,
  composerPlaceholder,
  heardTranscript,
  asksBlocked,
  waitingAsks,
  threadActivity,
  conversationSendDisabledReason,
  conversationSteerReason,
  messageBody,
  preparingCloud,
  processFit,
  RESTART_PROMPT,
  type SubmitRequest,
} from "@openorc/client";
import {
  WORKSPACE_ID,
  executionMode,
  forkUnavailable,
  harnessShortName,
  isSubagentThread,
  placeOf,
  type Project,
  type Run,
  type Task,
  type ThreadSummary,
  type WorkspaceMode,
  type HostedFileScope,
} from "@openorc/protocol";
import { useCallback, useState, type ComponentProps, type ReactNode } from "react";
import { useConversationSettings, useConversationTranscript, useRpc, useRpcMutation, useSubmit } from "../lib/client";
import { useThreadAccounts } from "../lib/use-thread-accounts";
import { MessageMarks, useMessageMarks } from "./MarkedText";
import { useConversationDraft } from "../lib/conversation-draft";
import {
  conversationEmptyHint,
  conversationEmptyTitle,
  conversationLocation,
  conversationWorkspaceMode,
  linkFolder,
  toolPathBase,
  workspaceDestination,
} from "../lib/conversation-status-presentation";
import { openThread, useRouter, type MessageTarget } from "../lib/router";
import { useConnectorMentions } from "../lib/connector-mentions";
import { useSkillCommands } from "../lib/skill-commands";
import { ConversationVoice, useRunVoices } from "../lib/turn-authors";
import { useTurnFooters } from "../lib/turn-footers";
import { useCloudSignInGate } from "./CloudSignInOffer";
import { AnswersBlocked, AsksDocked } from "./ask-answer";
import { useHostedComposer } from "./HostedSendNotice";
import { HostedConversationBoundary } from "./HostedConversationBoundary";
import { CloudPreparing, CloudStart } from "./CloudStart";
import { Composer, type SlashCommand } from "./Composer";
import { ComposerChoice } from "./ComposerChoice";
import { GitBranch, Laptop } from "./icons";
import { SessionRecovery } from "./SessionRecovery";
import { SubagentConversation } from "./SubagentConversation";
import { ThreadMoveCard } from "./ThreadMoveCard";
import { Transcript } from "./Transcript";
import { TurnChangesProvider, useTurnFooter } from "./TurnFooter";
import { Button, Empty } from "./ui";
import { useOrclingConversation } from "./useOrclingConversation";
import { useOptimisticSend } from "./useOptimisticSend";
import { useThreadControls } from "./useThreadControls";
import { ConversationDraftBoundary } from "./ConversationDraftBoundary";
import { useTaskComposerDraft } from "../lib/task-composer-draft";
import { forgetHostedIntent, withHostedIntent } from "../lib/hosted-send-intent";

export type ConversationScope = { kind: "task"; task: Task } | { kind: "thread"; thread: ThreadSummary };

/**
 * The chat over a task's or a thread's runs, shown as one continuous
 * transcript. The composer continues the live session when there is one,
 * queues while the agent is busy, and otherwise starts a run that resumes
 * the agent's last session. Thread drafts survive leaving the screen.
 */
type ConversationProps = { scope: ConversationScope; project: Project; toolbarTarget?: HTMLElement | null };

export function Conversation({ scope, project }: ConversationProps) {
  if (scope.kind === "thread" && scope.thread.owner?.brain === "hosted" && !isSubagentThread(scope.thread))
    return (
      <HostedConversationBoundary thread={scope.thread}>
        <ConversationDraftBoundary thread={scope.thread}>
          {({ draftKey, scope: files }) => <IndividualConversation key={draftKey} scope={scope} project={project} draftKey={draftKey} hostedFiles={files} />}
        </ConversationDraftBoundary>
      </HostedConversationBoundary>
    );
  const content =
    scope.kind === "thread" && isSubagentThread(scope.thread) ? <SubagentConversation thread={scope.thread} project={project} /> : <IndividualConversation scope={scope} project={project} />;
  return scope.kind === "thread" && scope.thread.owner?.brain === "hosted" ? <HostedConversationBoundary thread={scope.thread}>{content}</HostedConversationBoundary> : content;
}

/** A conversation that ran with one agent, now set to another: that agent starts fresh, from a brief. */
function SwitchingNote({ agent }: { agent: string | null }) {
  if (!agent) return null;
  return <div className="text-xs text-ink-3 px-1">Switching to {harnessShortName(agent)} starts a fresh session. It gets a brief of this conversation, not the other agent's session.</div>;
}

/**
 * The checkout a conversation works in, read only where the project folder has git: the branch a local checkout
 * publishes, which the agent may switch mid-conversation, and its uncommitted changes.
 */
function useCheckout(thread: ThreadSummary | null, project: Project) {
  const git = useProjectGit(thread?.owner?.brain === "hosted" ? null : project.id);
  const checkout = useRpc(
    "git.threadPushState",
    { threadId: thread?.id ?? "" },
    { enabled: Boolean(thread) && thread?.owner?.brain !== "hosted" && git.tracks && thread?.workspaceMode === "current", refetchInterval: 8000 },
  );
  const localChanges = useComposerChanges(thread && thread.owner?.brain !== "hosted" && git.tracks ? { kind: "thread", id: thread.id, projectName: project.name, thread } : null);
  const hostedChanges = useHostedComposerChanges(thread?.owner?.brain === "hosted" ? thread : null, project.name);
  return { checkout, changes: hostedChanges ?? localChanges, git };
}

/** The message the route opened this conversation at, such as a search result; only the focused conversation has one. */
function useMessageTarget(scope: ConversationScope): MessageTarget | undefined {
  return useRouter(({ route }) => {
    if (route.view === "thread" && scope.kind === "thread" && route.threadId === scope.thread.id) return route.message;
    if (route.view === "task" && scope.kind === "task" && route.taskId === scope.task.id) return route.message;
    return undefined;
  });
}

/** A thread's own `/` commands; compacting waits for the turn to finish. */
function threadCommands({
  thread,
  working,
  compact,
  fork,
}: {
  thread: ThreadSummary | null;
  working: boolean;
  compact: ((input: { id: string }) => void) | undefined;
  fork: (() => void) | undefined;
}): SlashCommand[] {
  if (!thread) return [];
  return [
    ...(!working && compact ? [{ name: "compact", hint: "Fold the conversation so far into a summary", run: () => compact({ id: thread.id }) }] : []),
    ...(fork ? [{ name: "fork", hint: "Continue in a new thread from here", run: fork }] : []),
  ];
}

/** What the composer's dock is given: the asks that wait, whose answer they wait on in words, and why they can't be answered from here. */
function dockedAsks(heard: Parameters<typeof waitingAsks>[0], thread: ThreadSummary | null, blocked: string | null) {
  return { asks: waitingAsks(heard), asksLabel: threadActivity({ activity: "waiting", owner: thread?.owner })?.text, asksBlocked: blocked };
}

/** What a conversation's transcript reads from around it: whose voice each turn is, the marks its messages are drawn with, and its turns' change footers. */
function TranscriptContext({
  voice,
  marks,
  footers,
  threadId,
  answersBlocked = null,
  children,
}: {
  answersBlocked?: string | null;
  voice: ComponentProps<typeof ConversationVoice.Provider>["value"];
  marks: ComponentProps<typeof MessageMarks.Provider>["value"];
  footers: ComponentProps<typeof TurnChangesProvider>["footers"];
  threadId: ComponentProps<typeof TurnChangesProvider>["threadId"];
  children: ReactNode;
}) {
  return (
    <ConversationVoice.Provider value={voice}>
      <MessageMarks.Provider value={marks}>
        <TurnChangesProvider footers={footers} threadId={threadId}>
          <AnswersBlocked.Provider value={answersBlocked}>
            <AsksDocked.Provider value>{children}</AsksDocked.Provider>
          </AnswersBlocked.Provider>
        </TurnChangesProvider>
      </MessageMarks.Provider>
    </ConversationVoice.Provider>
  );
}

function IndividualConversation({ scope, project, draftKey: capturedKey, hostedFiles }: { scope: ConversationScope; project: Project; draftKey?: string; hostedFiles?: HostedFileScope | null }) {
  const runsQuery = useRpc(scope.kind === "task" ? "runs.listForTask" : "runs.listForThread", scope.kind === "task" ? { taskId: scope.task.id } : { threadId: scope.thread.id });
  const runs = runsQuery.data ?? [];
  const firstTaskRun = scope.kind === "task" && runs.length === 0;
  const [selectedWorkspace, setWorkspace] = useState<WorkspaceMode | null>(null);
  const workspaceMode = conversationWorkspaceMode({ scope, firstTaskRun, selected: selectedWorkspace });
  const thread = scope.kind === "thread" ? scope.thread : null;
  const conversation = { kind: scope.kind, id: scope.kind === "thread" ? scope.thread.id : scope.task.id };
  const { checkout, changes: composerChanges, git } = useCheckout(thread, project);
  const accounts = useThreadAccounts(thread, project);

  const activeRun: Run | undefined = runs[runs.length - 1];
  const links = linkFolder(scope, project);
  const target = useMessageTarget(scope);
  const { merged, transcripts, liveTranscript, hasOlder, loadOlder } = useConversationTranscript({ runs, threadId: thread?.id ?? null, target, hosted: thread?.owner?.brain === "hosted" });
  const footers = useTurnFooters({
    threadId: thread?.id ?? null,
    transcripts,
    blocks: merged?.blocks,
    basePath: toolPathBase(scope, links ?? project.rootPath),
    hosted: thread?.owner?.brain === "hosted",
  });

  const settings = useConversationSettings({ thread, activeRun });
  const { choice, mode, permission, permissionReady, permissionError } = settings;
  const orclings = useOrclingConversation({ thread, runs, choice, onModel: settings.selectModel, accounts });
  const voice = useRunVoices(orclings.voice, runs, thread);
  const draftKey = capturedKey ?? `conversation.${conversation.id}`;
  const { prompt, setPrompt, clearDraft, error: draftError } = useConversationDraft({ draftKey, threadId: thread?.id ?? null, initialText: thread?.draft ?? "" });
  const taskDraft = useTaskComposerDraft({ scope: hostedFiles ?? null, threadId: thread?.id ?? null, draftKey, prompt, setPrompt });
  const submitter = useSubmit();
  const [sends, setSends] = useState(0);
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
  const cloud = useHostedComposer(thread, { choice, mode, permission });
  const controls = useThreadControls(thread, runs.length, { canSteer, reason: steerReason, blocked: cloud.blocked, onSent: () => setSends((count) => count + 1) });
  const sendDisabledReason = conversationSendDisabledReason({ permissionReady, historyLoading: runsQuery.isLoading, historyFailed: Boolean(runsQuery.error), hasModel: Boolean(choice), thread });
  const turnFooter = useTurnFooter({ footers, threadId, working });
  const switching = Boolean(thread && choice && runs.length > 0 && !runs.some((r) => r.agent === choice.agent));
  const signIn = useCloudSignInGate(cloudTurnOf(thread, choice, live || working));

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
    task: taskDraft.task,
  };
  const optimistic = useOptimisticSend({ submitter, request, run: merged, attachmentsKey: `${draftKey}.attachments`, restore: setPrompt, route: orclings.route });
  const submit = async (text: string, attachments: string[], now: boolean) => {
    setSends((count) => count + 1);
    // A message to an Orcling goes to the Orcling, not to this conversation's agent.
    if (await orclings.ask(messageBody(text, attachments), attachments)) return clearDraft();
    await signIn.ready();
    const sent = { ...request, now };
    const message = await withHostedIntent(hostedFiles ? draftKey : null, sent, { text, attachments });
    await optimistic.send(sent, message);
    if ("requestId" in message) forgetHostedIntent(draftKey);
    if (!taskDraft.accepted(text)) clearDraft();
  };
  const restart = () => submitter.submit({ ...request, now: false, restart: true }, { text: RESTART_PROMPT, attachments: [] }).then(clearDraft);
  const continueWith = (claudeAccountId: string) => submitter.submit({ ...request, now: false, claudeAccountId }, { text: CONTINUE_PROMPT, attachments: [] }).then(clearDraft);

  const suggestScope = cloud.hosted ? null : conversation;
  const skills = useSkillCommands(suggestScope, choice?.agent);
  const connectorMentions = useConnectorMentions(suggestScope, choice?.agent, executionMode(mode, permission));
  const onFork = thread && !forkUnavailable(thread.agent) && !placeOf(thread).elsewhere ? forkConversation : undefined;
  const commands: SlashCommand[] = [...threadCommands({ thread, working, compact: cloud.hosted ? undefined : compact.mutate, fork: onFork }), ...skills.commands];
  const marks = useMessageMarks(skills.commands, connectorMentions);

  const location = conversationLocation({ scope, project, mode: workspaceMode, basePath: links ?? project.rootPath, checkoutBranch: checkout.data?.branch, plainFolder: git.state === "none" });
  const emptyHint = conversationEmptyHint({ task: scope.kind === "task", workspace: project.id === WORKSPACE_ID });
  const answersBlocked = asksBlocked(thread);
  const placeholder = composerPlaceholder(choice?.agent, thread);
  const heard = optimistic.run ? heardTranscript(optimistic.run, thread) : null;

  function renderTranscript() {
    if (heard && heard.blocks.length > 0)
      return (
        <TranscriptContext voice={voice} marks={marks} footers={footers} threadId={threadId} answersBlocked={answersBlocked}>
          <Transcript
            working={working}
            media={links ? { basePath: links, fileScope: conversation } : { fileLinks: "cite" }}
            run={heard}
            scrollKey={conversation.id}
            followKey={sends}
            onFork={onFork}
            hasOlder={hasOlder}
            onLoadOlder={loadOlder}
            reveal={target}
            trailing={turnFooter}
          />
        </TranscriptContext>
      );
    if (runsQuery.isLoading) return null;
    return (
      orclings.empty ?? (
        <CloudStart thread={thread} runs={runs.length} fallback={<Empty title={conversationEmptyTitle({ count: runs.length, firstTaskRun })}>{runs.length === 0 ? emptyHint : ""}</Empty>} />
      )
    );
  }
  return (
    <div className="conversation-pane h-full min-w-0 flex flex-col min-h-0">
      <div className="flex-1 min-h-0 relative">{renderTranscript()}</div>
      <div className="composer-padding shrink-0 px-6 pb-6 pt-2">
        <div className="max-w-chat w-full min-w-0 mx-auto grid grid-cols-1 gap-2">
          <ConversationVoice.Provider value={voice}>
            <Composer
              handle={controls.composer}
              draftKey={`${draftKey}.attachments`}
              hostedFiles={hostedFiles}
              value={prompt}
              onChange={setPrompt}
              onSubmit={submit}
              onReady={taskDraft.prepared ? undefined : cloud.onReady}
              onInsertTask={taskDraft.insert}
              placeholder={orclings.placeholder ?? placeholder}
              mentions={orclings.mentions}
              modelControl={orclings.modelControl}
              accounts={accounts}
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
              notices={
                <>
                  <ThreadMoveCard thread={thread} />
                  <CloudPreparing thread={preparingCloud(thread, runs.length)} />
                  {controls.queue}
                  {controls.commands}
                  {thread?.session && !working ? (
                    <SessionRecovery
                      thread={thread}
                      disabled={!choice || optimistic.busy}
                      onRestart={() => void restart().catch(() => {})}
                      onContinueWith={(id) => void continueWith(id).catch(() => {})}
                    />
                  ) : null}
                  {signIn.offer}
                  {cloud.notice}
                  <SwitchingNote agent={switching && choice ? choice.agent : null} />
                  <ApplyingAutonomous
                    shown={Boolean(settingsPending && activeRun && thread && activeRun.mode === "act" && permission === "autonomous" && activeRun.permissionMode !== permission)}
                    failed={Boolean(settings.error)}
                  />
                </>
              }
              busy={optimistic.busy}
              allowEmpty={firstTaskRun}
              disabledReason={taskDraft.blocked ?? sendDisabledReason ?? cloud.blocked}
              live={live && activeRun ? { runId: activeRun.id, working } : null}
              queueing={Boolean(thread && working)}
              liveByDefault
              steerable={canSteer}
              steerReason={steerReason}
              context={cloud.hosted ? (liveTranscript?.context ?? null) : (thread?.context ?? null)}
              compacting={compact.isPending}
              generatingImage={generatingImage}
              onCompact={thread && !working ? () => compact.mutate({ id: thread.id }) : undefined}
              compactDisabledReason={working ? "Available after this turn finishes." : undefined}
              fileSearch={conversation}
              commands={commands}
              onCommandsWanted={skills.onCommandsWanted}
              commandsNotice={skills.commandsNotice}
              {...connectorMentions}
              {...cloud.limits}
              {...dockedAsks(heard, thread, answersBlocked)}
              error={cloud.shown((submitter.error ?? controls.error ?? compact.error ?? fork.error ?? settings.error ?? draftError)?.message ?? permissionError)}
            >
              {firstTaskRun && scope.kind === "task" ? (
                <TaskWorkspaceChoice task={scope.task} project={project} value={workspaceMode} onChange={setWorkspace} busy={optimistic.busy || !runsQuery.data} />
              ) : null}
            </Composer>
          </ConversationVoice.Provider>
          {firstTaskRun ? (
            <TaskDestination destination={workspaceDestination({ mode: workspaceMode, rootPath: project.rootPath, taskPath: scope.kind === "task" ? scope.task.worktreePath : null })} />
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

function TaskWorkspaceChoice({ task, project, value, onChange, busy }: { task: Task; project: Project; value: WorkspaceMode; onChange(value: WorkspaceMode): void; busy: boolean }) {
  return (
    <ComposerChoice
      ariaLabel="Where the task works"
      value={value}
      options={[
        { value: "current" as const, label: "Checkout", hint: project.rootPath, icon: Laptop },
        { value: "worktree" as const, label: "Worktree", hint: task.worktreePath ?? `New isolated worktree from ${task.baseRef ?? project.defaultBranch ?? "HEAD"}`, icon: GitBranch },
      ]}
      onChange={onChange}
      disabled={busy || Boolean(task.worktreePath)}
    />
  );
}

/** Autonomous chosen mid-turn, applied to the running turn, or why it could not be. */
function ApplyingAutonomous({ shown, failed }: { shown: boolean; failed: boolean }) {
  if (!shown) return null;
  return (
    <div role="status" className="text-xs text-ink-3 px-1">
      {failed ? "Could not apply Autonomous. Select it again to retry." : "Applying Autonomous to the current turn…"}
    </div>
  );
}

/** Where a task's first run will work, under its composer; whole on demand when the line cuts it off. */
function TaskDestination({ destination }: { destination: string }) {
  return (
    <p className="px-1 text-xs text-ink-3 truncate" data-tip={destination}>
      {destination}
    </p>
  );
}

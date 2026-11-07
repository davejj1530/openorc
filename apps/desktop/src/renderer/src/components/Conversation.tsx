import { useComposerChanges } from "../lib/composer-changes";
import { useProjectGit } from "../lib/project-git";
import {
  cloudTurnOf,
  CONTINUE_PROMPT,
  conversationActivity,
  conversationPlaceholder,
  conversationSendDisabledReason,
  conversationSteerReason,
  messageBody,
  preparingCloud,
  processFit,
  RESTART_PROMPT,
  type SubmitRequest,
} from "@openorc/client";
import { WORKSPACE_ID, defaultHarnessId, harnessShortName, isSubagentThread, type Project, type Run, type Task, type ThreadSummary, type WorkspaceMode } from "@openorc/protocol";
import { useCallback, useState } from "react";
import { useConversationSettings, useConversationTranscript, useRpc, useRpcMutation, useSubmit } from "../lib/client";
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
import { useSkillCommands } from "../lib/skill-commands";
import { ConversationVoice, useRunVoices } from "../lib/turn-authors";
import { useTurnFooters } from "../lib/turn-footers";
import { BackgroundCommands } from "./BackgroundCommands";
import { useCloudSignInGate } from "./CloudSignInOffer";
import { CloudPreparing, CloudStart, queueAfterStart } from "./CloudStart";
import { Composer, type SlashCommand } from "./Composer";
import { ComposerChoice } from "./ComposerChoice";
import { GitBranch, Laptop } from "./icons";
import { MessageQueue } from "./MessageQueue";
import { SessionRecovery } from "./SessionRecovery";
import { SubagentConversation } from "./SubagentConversation";
import { ThreadMoveCard } from "./ThreadMoveCard";
import { Transcript } from "./Transcript";
import { TurnChangesProvider, useTurnFooter } from "./TurnFooter";
import { Button, Empty } from "./ui";
import { useOrclingConversation } from "./useOrclingConversation";

export type ConversationScope = { kind: "task"; task: Task } | { kind: "thread"; thread: ThreadSummary };

/**
 * The chat over a task's or a thread's runs, shown as one continuous
 * transcript. The composer continues the live session when there is one,
 * queues while the agent is busy, and otherwise starts a run that resumes
 * the agent's last session. Thread drafts survive leaving the screen.
 */
type ConversationProps = { scope: ConversationScope; project: Project; toolbarTarget?: HTMLElement | null };

export function Conversation({ scope, project }: ConversationProps) {
  if (scope.kind === "thread" && isSubagentThread(scope.thread)) return <SubagentConversation thread={scope.thread} project={project} />;
  return <IndividualConversation scope={scope} project={project} />;
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

/** A thread's own `/` commands; compacting waits for the turn to finish. */
function threadCommands({ working, compact, selectMode, fork }: { working: boolean; compact: () => void; selectMode: (mode: "plan" | "act") => void; fork: () => void }): SlashCommand[] {
  return [
    ...(!working ? [{ name: "compact", hint: "Fold the conversation so far into a summary", run: compact }] : []),
    { name: "plan", hint: "Switch this thread to plan mode", run: () => selectMode("plan") },
    { name: "act", hint: "Switch this thread to act mode", run: () => selectMode("act") },
    { name: "fork", hint: "Continue in a new thread from here", run: fork },
  ];
}

function IndividualConversation({ scope, project }: { scope: ConversationScope; project: Project }) {
  const runsQuery = useRpc(scope.kind === "task" ? "runs.listForTask" : "runs.listForThread", scope.kind === "task" ? { taskId: scope.task.id } : { threadId: scope.thread.id });
  const runs = runsQuery.data ?? [];
  const firstTaskRun = scope.kind === "task" && runs.length === 0;
  const [selectedWorkspace, setWorkspace] = useState<WorkspaceMode | null>(null);
  const workspaceMode = conversationWorkspaceMode({ scope, firstTaskRun, selected: selectedWorkspace });
  const thread = scope.kind === "thread" ? scope.thread : null;
  const conversation = { kind: scope.kind, id: scope.kind === "thread" ? scope.thread.id : scope.task.id };
  const { checkout, changes: composerChanges, git } = useCheckout(thread, project);

  const activeRun: Run | undefined = runs[runs.length - 1];
  const links = linkFolder(scope, project);
  const target = useMessageTarget(scope);
  const { merged, transcripts, liveTranscript, hasOlder, loadOlder } = useConversationTranscript({ runs, threadId: thread?.id ?? null, target });
  const footers = useTurnFooters({ threadId: thread?.id ?? null, transcripts, blocks: merged?.blocks, basePath: toolPathBase(scope, links ?? project.rootPath) });

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
  const sendDisabledReason = conversationSendDisabledReason({ permissionReady, historyLoading: runsQuery.isLoading, historyFailed: Boolean(runsQuery.error), hasModel: Boolean(choice), thread });
  const busy = submitter.pending;
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
  };
  const submit = async (text: string, attachments: string[], now: boolean) => {
    setSends((count) => count + 1);
    // A message to an Orcling goes to the Orcling, not to this conversation's agent.
    if (await orclings.ask(messageBody(text, attachments), attachments)) return clearDraft();
    await signIn.ready();
    await submitter.submit({ ...request, now }, { text, attachments });
    clearDraft();
  };
  const restart = () => submitter.submit({ ...request, now: false, restart: true }, { text: RESTART_PROMPT, attachments: [] }).then(clearDraft);
  const continueWith = (claudeAccountId: string) => submitter.submit({ ...request, now: false, claudeAccountId }, { text: CONTINUE_PROMPT, attachments: [] }).then(clearDraft);

  const skills = useSkillCommands(conversation, choice?.agent);
  const commands: SlashCommand[] = [
    ...(thread ? threadCommands({ working, compact: () => compact.mutate({ id: thread.id }), selectMode: settings.selectMode, fork: forkConversation }) : []),
    ...skills.commands,
  ];

  const location = conversationLocation({ scope, project, mode: workspaceMode, basePath: links ?? project.rootPath, checkoutBranch: checkout.data?.branch, plainFolder: git.state === "none" });
  const emptyHint = conversationEmptyHint({ task: scope.kind === "task", workspace: project.id === WORKSPACE_ID });
  const placeholder = conversationPlaceholder({ firstTaskRun, working, canSteer, agent: choice?.agent });

  function renderTranscript() {
    if (merged && merged.blocks.length > 0)
      return (
        <ConversationVoice.Provider value={voice}>
          <TurnChangesProvider footers={footers} threadId={threadId}>
            <Transcript
              working={working}
              media={links ? { basePath: links, fileScope: conversation } : { fileLinks: "cite" }}
              run={merged}
              scrollKey={conversation.id}
              followKey={sends}
              onFork={thread ? forkConversation : undefined}
              hasOlder={hasOlder}
              onLoadOlder={loadOlder}
              reveal={target}
              trailing={turnFooter}
            />
          </TurnChangesProvider>
        </ConversationVoice.Provider>
      );
    if (runsQuery.isLoading) return null;
    return (
      orclings.empty ?? (
        <CloudStart thread={thread} runs={runs.length} fallback={<Empty title={conversationEmptyTitle({ count: runs.length, firstTaskRun })}>{runs.length === 0 ? emptyHint : ""}</Empty>} />
      )
    );
  }
  return (
    <div className="h-full min-w-0 flex flex-col min-h-0">
      <div className="flex-1 min-h-0 relative">{renderTranscript()}</div>
      <div className="composer-padding shrink-0 px-6 pb-6 pt-2">
        <div className="max-w-chat w-full min-w-0 mx-auto grid grid-cols-1 gap-2">
          <ThreadMoveCard thread={thread} />
          <CloudPreparing thread={preparingCloud(thread, runs.length)} />
          {thread ? (
            <MessageQueue
              messages={queueAfterStart(thread, runs.length)}
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
          {thread?.session && !working ? (
            <SessionRecovery thread={thread} disabled={!choice || busy} onRestart={() => void restart().catch(() => {})} onContinueWith={(id) => void continueWith(id).catch(() => {})} />
          ) : null}
          {signIn.offer}
          <SwitchingNote agent={switching && choice ? choice.agent : null} />
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
            onCommandsWanted={skills.onCommandsWanted}
            commandsNotice={skills.commandsNotice}
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
                disabled={busy || Boolean(scope.task.worktreePath) || !runsQuery.data}
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

import { composerActivity, composerSendBlock, sendCluster, sendsNow, type SkillCommand, type SkillListNotice, type WaitingAsk } from "@openorc/client";
import {
  ExecutionMode,
  executionMode,
  executionModeAvailable,
  executionModePresentation,
  executionModeSettings,
  executionModeUnavailable,
  harnessShortName,
  type AgentKind,
  type FileScope,
  type HarnessId,
  type PermissionPreset,
  type RunMode,
  type UsableConnector,
  type HostedFileScope,
} from "@openorc/protocol";
import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { useComposerFiles } from "./useComposerFiles";
import { type MentionEntry } from "../lib/composer-mentions";
import { useComposerFit } from "../lib/composer-fit";
import { useComposerSubmission } from "../lib/composer-submission";
import { ComposerChoice } from "./ComposerChoice";
import { ComposerReadOnly } from "./composer-read-only";
import { ComposerDropZone, useComposerDrop } from "./ComposerDropZone";
import { ComposerChangesBar } from "./ComposerCommitChip";
import { ComposerAddMenu, type AddOffers } from "./ComposerAddMenu";
import { ComposerAsk } from "./ComposerAsk";
import { ComposerInput, type ComposerLists } from "./ComposerInput";
import type { ComposerEditorHandle } from "./composer-editor/ComposerEditor";
import { ComposerSendCluster } from "./ComposerSendButton";
import { ContextUsage } from "./ContextUsage";
import { useHostedControlReason } from "./HostedConversationBoundary";
import { hostedCommandReason } from "./HostedComposerControls";
import { Cloud, Eye, Laptop, Lightbulb, ShieldCheck, ShieldOff } from "./icons";
import { type PickerAccounts } from "./ModelPickerAccounts";
import { ComposerModelPicker, type ModelChoice } from "./ModelPicker";
import { Tooltip } from "./ui";

export const permissionLabel: Record<PermissionPreset, string> = { review: "Review", trusted: "Workspace access", autonomous: "Autonomous" };

export type { Attachment } from "../lib/composer-attachments";

function composerDestination(props: ComposerProps): ReactNode {
  if (props.hasStarted) return null;
  if (props.children) return <div className="composer-destination">{props.children}</div>;
  if (props.presentation === "new-thread" || !props.location.label) return null;
  return (
    <span className="composer-location">
      {props.location.cloud ? <Cloud size={14} /> : <Laptop size={14} />}
      <span>{props.location.label}</span>
    </span>
  );
}

/**
 * A `/` entry. The two kinds differ in who acts on it.
 *
 * `run` is the app's own command: picking it clears the prompt and does the
 * thing. `insert` belongs to the provider, which resolves `/name` out of the
 * prompt text itself, so picking it writes `/name ` at the caret and leaves
 * the rest of the message alone. The `never` arms make the union exclusive, so
 * an entry carrying neither, or both, fails to typecheck rather than picking
 * silently doing nothing.
 */
export type SlashCommand = { name: string; hint: string; run: () => void; insert?: never; prefix?: never; aliases?: never; displayName?: never; icon?: never } | (SkillCommand & { run?: never });

export interface ComposerChanges {
  projectName: string;
  files: number;
  uncounted?: boolean;
  insertions: number;
  deletions: number;
  onReview: () => void;
  onCommit: () => void;
  commitDisabledReason?: string | null;
  /** The panel beside the composer shows these changes with its own Commit, so the chip steps aside. */
  inPanel?: boolean;
  error?: string | null;
  onRetry: () => void;
}

/** What a caller can do to the composer from outside it. */
export interface ComposerHandle {
  /** Puts a message's words back after what is written, as one step to undo, and its files back beside it. */
  append: (text: string, attachments: readonly string[]) => void;
}

export interface ComposerProps {
  handle?: Ref<ComposerHandle>;
  value: string;
  onChange: (text: string) => void;
  /** `now` requests live input; false explicitly queues during an active turn. */
  onSubmit: (text: string, attachments: string[], now: boolean) => Promise<void>;
  draftKey?: string;
  hostedFiles?: HostedFileScope | null | undefined;
  onInsertTask?: (() => void) | undefined;
  placeholder: string;
  model: ModelChoice | null;
  onModel: (choice: ModelChoice) => void;
  /** A saved identity can supply its model controls in the toolbar. */
  modelControl?: ReactNode;
  /** The Claude accounts the conversation can run on, offered in the model picker with their usage. */
  accounts?: PickerAccounts | undefined;
  /** Where the conversation runs takes only these agents, and Fast only when `fast`. */
  modelLimits?: { harnesses: readonly HarnessId[]; fast: boolean } | undefined;
  mode: RunMode;
  onMode: (mode: RunMode) => void;
  permission: PermissionPreset;
  onPermission: (permission: PermissionPreset) => void;
  /** Persist the unified mode atomically when the parent stores settings. */
  onExecutionMode?: (settings: { mode: RunMode; permissionMode: PermissionPreset }) => void;
  settingsDisabled?: boolean;
  settingsDisabledReason?: string;
  modeDescriptionId?: string;
  /** A caller can fence mode and permission controls independently. */
  permissionDisabled?: boolean;
  permissionDisabledReason?: string;
  permissionDescriptionId?: string;
  attachmentsDisabledReason?: string | null;
  /** Where the agent runs. A caller supplying its own destination control may omit the static label.
   * `cloud` when the agent works in a sandbox and `directory` is the worktree its changes arrive in. */
  location: { label: string | null; branch: string | null; directory?: string; cloud?: boolean };
  /** Initial execution location is chosen before the conversation starts. */
  hasStarted?: boolean;
  /** Uncommitted changes, shown as the Commit chip over the composer's left edge. */
  changes?: ComposerChanges | null;
  /** Status and recovery controls below the Commit chip and above the writing surface; an empty slot takes no room. */
  notices?: ReactNode;
  busy?: boolean;
  disabledReason?: string | null;
  /** Why this person may only read the thread. The draft stays editable; controls cannot act. */
  readOnlyReason?: string | null;
  /** A saved task can start from its spec without an additional message. */
  allowEmpty?: boolean;
  /** Live-run controls, when a session is open. */
  live?: { runId: string; working: boolean } | null;
  /** Custom stop controls for a caller that owns execution. */
  stopAction?: { working: boolean; pending: boolean; onStop: () => void };
  /** A turn is running, so a message goes into it now or waits for it. */
  queueing?: boolean;
  /** The running turn can take a message now. */
  steerable?: boolean;
  /** Why it cannot, when it cannot. The core words these; the dimmed "Send now" says it on demand. */
  steerReason?: string | null;
  /** Mid-turn, Enter sends now when the turn can take it, rather than queueing; Command and Enter does the other. */
  liveByDefault?: boolean;
  /** How full the conversation is; the ring beside send. */
  context?: { used: number; window: number | null } | null;
  onCompact?: () => void;
  compactDisabledReason?: string;
  compacting?: boolean;
  generatingImage?: boolean;
  /** Where @ file mentions search. */
  fileSearch?: FileScope;
  /** Orclings `@` can address; they take the popover before file matches. */
  mentions?: MentionEntry[];
  commands?: SlashCommand[];
  /** Called as a `/` or `$` word starts, so a list read a while ago can be read again before it is used. */
  onCommandsWanted?: () => void;
  commandsNotice?: SkillListNotice | null;
  /** Connectors `@` can name, and the call that reads them as an `@` word starts. */
  connectors?: UsableConnector[];
  connectorsAside?: { connectors: UsableConnector[]; reason: string } | undefined;
  connectorsLoading?: boolean | undefined;
  onConnectorsWanted?: () => void;
  autoFocus?: boolean;
  /** The person is about to write: they focused the message or started one. */
  onReady?: (() => void) | undefined;
  size?: "md" | "lg";
  /** The landing screen draws the roomier composer and places the Commit chip itself. A small chat keeps only attach and send. */
  presentation?: "conversation" | "new-thread" | "small";
  error?: string | null;
  /** What the agent waits on the person for, docked at the top of the composer; the first shows. */
  asks?: WaitingAsk[];
  /** The dock's name for screen readers. */
  asksLabel?: string | undefined;
  /** Why the asks can't be answered now, as when the thread's place can't be reached. */
  asksBlocked?: string | null;
  children?: ReactNode;
}

/** The sent text, lifting away as the prompt clears. */
function useSentGhost(text: string | null) {
  const [ghost, setGhost] = useState<{ text: string; key: number } | null>(null);
  useEffect(() => {
    if (text) setGhost((previous) => ({ text, key: (previous?.key ?? 0) + 1 }));
  }, [text]);
  return { ghost, clear: () => setGhost(null) };
}

/**
 * The one composer, for the landing screen and every conversation. Files
 * paste or drop in and ride along with the prompt, images as thumbnails and
 * everything else as a named card; attach, the model and the mode sit in the
 * bar under the text with the context ring and send at its end; uncommitted
 * changes sit in the Commit chip over its left edge. @ mentions a file, / runs a command.
 */
/** A file a message carried, as the composer shows it again: an image by its served picture, anything else by its name. */
/** Why the last send or stop failed, and a failed read of the changes with its retry. */
function ComposerAlerts({ message, changes }: { message: ReactNode; changes: ComposerProps["changes"] }) {
  return (
    <>
      {message ? (
        <div role="alert" className="composer-alert">
          {message}
        </div>
      ) : null}
      {changes?.error ? (
        <p role="status" className="composer-alert">
          {changes.error}{" "}
          <button type="button" className="underline" onClick={changes.onRetry}>
            Retry
          </button>
        </p>
      ) : null}
    </>
  );
}

export function Composer(props: ComposerProps) {
  props = guardHostedCommand(props, useHostedControlReason("compact"));
  const isNewThread = props.presentation === "new-thread";
  const shell = useRef<HTMLDivElement>(null);
  const fitBar = useComposerFit();
  const files = useComposerFiles({ scope: props.hostedFiles, draftKey: props.draftKey, disabledReason: props.readOnlyReason ?? props.attachmentsDisabledReason });
  const { attachments, uploading } = files;
  const addFiles = (chosen: File[]) => (props.readOnlyReason ? Promise.resolve() : files.addFiles(chosen));
  const { value, onChange } = props;
  const editor = useRef<ComposerEditorHandle>(null);
  const appendFiles = files.append;
  useImperativeHandle(
    props.handle,
    () => ({
      append: (text, paths) => {
        const kept = value.trimEnd();
        const next = kept ? `${kept}\n${text}` : text;
        editor.current?.write(next, next.length);
        appendFiles(paths);
      },
    }),
    [value, appendFiles],
  );
  const interrupt = useRpcMutation("runs.interrupt");
  const { submission, submit: submitDraft, acknowledge } = useComposerSubmission(props.draftKey);
  const submitting = submission?.status === "pending";
  const [sentText, setSentText] = useState<string | null>(null);
  const sent = useSentGhost(sentText);
  useEffect(() => {
    if (submission?.status !== "accepted") return;
    if (value.trim() === submission.text) {
      onChange("");
      setSentText(submission.text);
    }
    acknowledge();
  }, [submission, value, onChange, acknowledge]);
  const drop = useComposerDrop((dropped) => void addFiles(dropped));
  const attachmentBlock = files.pendingReason ?? (attachments.length > 0 ? files.blocked : null);
  const canSend =
    Boolean(props.allowEmpty || props.value.trim() || attachments.length > 0) && !props.busy && !submitting && !props.readOnlyReason && !props.disabledReason && !attachmentBlock && uploading === 0;

  const canStop = !props.readOnlyReason && Boolean(props.stopAction?.working || (!props.stopAction && props.live?.working));
  const asks = props.asks ?? [];
  const focusField = useCallback(() => editor.current?.focus(), []);
  const cluster = sendCluster({
    readOnly: Boolean(props.readOnlyReason),
    queueing: Boolean(props.queueing),
    liveByDefault: Boolean(props.liveByDefault),
    steerable: Boolean(props.steerable),
    steerReason: props.steerReason,
    canStop,
    hasDraft: Boolean(props.value.trim()) || attachments.length > 0 || uploading > 0,
    startsTask: props.allowEmpty,
    asked: asks.length > 0 ? `${props.model ? harnessShortName(props.model.agent) : "The agent"} is waiting for your answer.` : null,
  });
  const submit = (otherWay: boolean) => {
    if (!canSend) return;
    files.clearError();
    const sent = attachments.map((attachment) => attachment.path);
    const text = props.value.trim();
    const now = sendsNow(cluster, otherWay);
    setSentText(null);
    submitDraft(text, sent, async () => {
      await props.onSubmit(text, sent, now);
      await files.accepted(sent);
    });
  };

  const lists = useRef<ComposerLists>(null);

  const stopping = props.stopAction?.pending ?? interrupt.isPending;
  const activityLabel = composerActivity({ stopping, submitting, generatingImage: Boolean(props.generatingImage) });
  const stop = () => {
    if (stopping || props.readOnlyReason) return;
    if (props.stopAction) props.stopAction.onStop();
    else if (props.live) interrupt.mutate({ runId: props.live.runId });
  };

  const content = (
    <div className={cn("composer min-w-0", props.size === "lg" && "composer-large", isNewThread && "composer-new-thread")}>
      {isNewThread ? null : <ComposerChangesBar changes={props.changes} />}
      <div className="mb-2 grid grid-cols-1 gap-2 empty:hidden">{props.notices}</div>
      <ComposerAlerts message={interrupt.error ? `Couldn’t stop the agent. ${interrupt.error.message}` : files.error || submission?.error || props.error} changes={props.changes} />
      <div ref={shell} className="composer-shell" data-dragging={drop.dragging || undefined} {...drop.handlers}>
        <ComposerAsk asks={asks} label={props.asksLabel} blocked={props.asksBlocked ?? null} fieldHasWords={Boolean(props.value.trim())} focusField={focusField} />
        {attachments.length > 0 || uploading > 0 ? <div className="composer-attachments">{files.content}</div> : null}
        <div className="composer-prompt">
          <ComposerInput
            value={props.value}
            onChange={props.onChange}
            onSubmit={submit}
            onFiles={addFiles}
            onReady={props.readOnlyReason ? undefined : props.onReady}
            draftKey={props.draftKey}
            disabled={Boolean(props.busy || submitting)}
            placeholder={props.placeholder}
            autoFocus={props.autoFocus}
            fileSearch={props.fileSearch}
            mentions={props.mentions}
            commands={props.readOnlyReason ? props.commands?.filter((command) => command.insert) : props.commands}
            onCommandsWanted={props.onCommandsWanted}
            commandsNotice={props.commandsNotice}
            connectors={props.connectors}
            connectorsAside={props.connectorsAside}
            connectorsLoading={props.connectorsLoading}
            onConnectorsWanted={props.onConnectorsWanted}
            suggestionAnchor={shell}
            suggestionSide={isNewThread ? "bottom" : "top"}
            editor={editor}
            lists={lists}
            ask={asks.length > 0 ? { enter: () => shell.current?.querySelector<HTMLElement>("[data-ask-control='head']")?.focus() } : null}
          />
          {sent.ghost ? (
            <div key={sent.ghost.key} className="composer-sent-ghost" aria-hidden="true" onAnimationEnd={sent.clear}>
              {sent.ghost.text}
            </div>
          ) : null}
        </div>
        <div ref={fitBar} className="composer-bar">
          {/* Attach, then where and how the agent works. Chips truncate before the end group moves. */}
          <div className="composer-tools">
            <ComposerAddMenu onFiles={(chosen) => void addFiles(chosen)} attachmentsBlocked={files.blocked} offers={addOffers(props)} lists={lists} onInsertTask={props.onInsertTask} />
            {composerDestination(props)}
            {props.presentation === "small" ? null : (
              <>
                {composerModelControl(props)}
                {composerModeControl(props)}
              </>
            )}
          </div>
          <div className="composer-end">
            {activityLabel ? (
              <span role="status" className="composer-activity">
                {activityLabel}
              </span>
            ) : null}
            <ComposerContext {...props} />
            <ComposerSendCluster
              cluster={cluster}
              canSend={canSend}
              block={composerSendBlock({ disabledReason: props.readOnlyReason ?? props.disabledReason, attachmentBlock })}
              stopping={stopping}
              onSend={submit}
              onStop={stop}
            />
          </div>
        </div>
        {drop.dragging ? <ComposerDropZone count={drop.count} /> : null}
      </div>
    </div>
  );
  return <ComposerReadOnly.Provider value={props.readOnlyReason ?? null}>{content}</ComposerReadOnly.Provider>;
}

function guardHostedCommand(props: ComposerProps, hosted: string | null): ComposerProps {
  return hosted ? { ...props, disabledReason: props.disabledReason ?? hostedCommandReason(props.value) } : props;
}

/** Context remains readable when the composer cannot act; compaction shares the controls' reason. */
function ComposerContext({ compacting, context, onCompact, compactDisabledReason }: Pick<ComposerProps, "compacting" | "context" | "onCompact" | "compactDisabledReason">) {
  const readOnlyReason = useContext(ComposerReadOnly);
  return (
    <>
      {compacting ? (
        <span role="status" className="composer-activity">
          Compacting context…
        </span>
      ) : null}
      {context ? <ContextUsage used={context.used} window={context.window} onCompact={onCompact} compacting={compacting} disabledReason={readOnlyReason ?? compactDisabledReason} /> : null}
    </>
  );
}

/** What the plus offers to name in this composer: only what its `@` and `/` lists can hold. */
function addOffers(props: ComposerProps): AddOffers {
  return {
    orclings: Boolean(props.mentions?.length),
    files: Boolean(props.fileSearch),
    connectors: Boolean(props.connectors?.length || props.onConnectorsWanted),
    skills: Boolean(props.commands?.some((command) => command.insert)),
    commands: Boolean(props.commands?.some((command) => !command.insert)),
    written: Boolean(props.value.trim()),
  };
}

function composerModelControl(props: ComposerProps): ReactNode {
  const unavailable = props.model ? executionModeUnavailable(props.model.agent, executionMode(props.mode, props.permission)) : null;
  return (
    <>
      {props.modelControl ?? <ComposerModelPicker value={props.model} onChange={props.onModel} accounts={props.accounts} limits={props.modelLimits} />}
      {unavailable ? (
        <Tooltip label={unavailable}>
          <span className="composer-activity" role="status">
            Mode unavailable
          </span>
        </Tooltip>
      ) : null}
    </>
  );
}

function composerModeControl(props: ComposerProps): ReactNode {
  return (
    <ComposerChoice
      ariaLabel="Mode"
      value={executionMode(props.mode, props.permission)}
      options={modeOptions(props.model?.agent)}
      onChange={(value) => {
        const next = executionModeSettings(value);
        if (props.onExecutionMode) props.onExecutionMode(next);
        else {
          props.onPermission(next.permissionMode);
          props.onMode(next.mode);
        }
      }}
      disabled={props.permissionDisabled || props.settingsDisabled}
      disabledReason={props.permissionDisabledReason ?? props.settingsDisabledReason}
      describedBy={props.permissionDescriptionId ?? props.modeDescriptionId}
    />
  );
}

/** How freely the agent works, one glyph each: it plans, it shows you each change, it asks outside the sandbox, nothing stops it. */
const modeIcons: Record<ExecutionMode, typeof ShieldCheck> = { plan: Lightbulb, review: Eye, trusted: ShieldCheck, autonomous: ShieldOff };

/** Every mode keeps its label for the trigger; the menu offers only the ones the agent can run. */
function modeOptions(agent: AgentKind | undefined) {
  return ExecutionMode.options.map((value) => ({ value, ...executionModePresentation(agent, value), icon: modeIcons[value], hidden: !executionModeAvailable(agent, value) }));
}

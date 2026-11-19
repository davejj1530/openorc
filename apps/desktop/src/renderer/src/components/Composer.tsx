import {
  composerActivity,
  composerSendBlock,
  draftOfNote,
  personTag,
  sendCluster,
  sendsNow,
  tagsPerson,
  type SendPayer,
  type SkillCommand,
  type SkillListNotice,
  type WaitingAsk,
} from "@openorc/client";
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
  type PermissionPreset,
  type RunMode,
  type UsableConnector,
  type HostedFileScope,
  type ThreadHandoffNote,
  type ThreadPerson,
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
import { useDraftNote, type ComposerNotes } from "./composer-notes";
import { ContextUsage } from "./ContextUsage";
import { hostedCommandReason, useHeldCommands, type HeldCommands } from "./HostedComposerControls";
import { Cloud, Eye, Laptop, Lightbulb, ShieldCheck, ShieldOff } from "./icons";
import { type PickerAccounts } from "./ModelPickerAccounts";
import { ComposerModelPicker, type ModelChoice, type ModelLimits } from "./ModelPicker";
import { Tooltip } from "./ui";

export const permissionLabel: Record<PermissionPreset, string> = { review: "Review", trusted: "Workspace access", autonomous: "Autonomous" };

export type { Attachment } from "../lib/composer-attachments";
export type { ComposerNotes } from "./composer-notes";

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
  /** Puts a person's tag before what is written, as Reply to their note does, with the keyboard after it all. */
  tag: (person: ThreadPerson, replyTo?: string) => void;
  /** Writes the server's note to the person who can release a block, their tag in place, before what is written. */
  note: (note: ThreadHandoffNote) => void;
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
  /** The accounts the conversation can run on, this Mac's Claude accounts or a cloud thread's, offered in the model picker with their usage. */
  accounts?: PickerAccounts | undefined;
  /** Where the conversation runs takes only these agents, and Fast only when `fast`; on OpenOrc Cloud, its models (`cloud`). */
  modelLimits?: ModelLimits | undefined;
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
   * `cloud` for a thread on OpenOrc Cloud, which has no folder here. */
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
  /** In a cloud thread others are in: whose sign-in and hours each way to send uses, said on demand. */
  sendPayer?: SendPayer | null;
  /** Why this person cannot Queue now, where joining the running turn stays open. */
  queueBlocked?: string | null;
  /** False where the server says this person may not stop the running turn. */
  canStopTurn?: boolean | undefined;
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
  onReady?: ((why?: "focus" | "words") => void) | undefined;
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
  /** Whether an ask's answer continues on the reader's own sign-in and hours, in words; null where it does not. */
  askContinues?: ((approvalId: string) => string | null) | undefined;
  /** In a cloud thread where the reader may post notes: `@` offers its people, and a draft that tags one posts as a note. */
  notes?: ComposerNotes | null | undefined;
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
/** A send's error, unless it is the reason the composer can't send now, which the composer already shows. */
const unshown = (error: string | null | undefined, readOnlyReason: string | null | undefined) => (error && error !== readOnlyReason ? error : null);

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
  props = guardHostedCommand(props, useHeldCommands());
  const isNewThread = props.presentation === "new-thread";
  const shell = useRef<HTMLDivElement>(null);
  const fitBar = useComposerFit();
  const files = useComposerFiles({ scope: props.hostedFiles, draftKey: props.draftKey, disabledReason: props.readOnlyReason ?? props.attachmentsDisabledReason });
  const { attachments, uploading } = files;
  const addFiles = (chosen: File[]) => (props.readOnlyReason ? Promise.resolve() : files.addFiles(chosen));
  const { value, onChange } = props;
  const editor = useRef<ComposerEditorHandle>(null);
  const appendFiles = files.append;
  const note = useDraftNote(props.notes, props.draftKey, value, attachments.length + uploading);
  const { pick: pickPerson, reply: replyTo } = note;
  useImperativeHandle(
    props.handle,
    () => ({
      append: (text, paths) => {
        const kept = value.trimEnd();
        const next = kept ? `${kept}\n${text}` : text;
        editor.current?.write(next, next.length);
        appendFiles(paths);
      },
      tag: (person, noteId) => {
        if (noteId) replyTo(person, noteId);
        else pickPerson(person);
        const next = `${personTag(person.id)} ${value.trimStart()}`;
        editor.current?.write(next, next.length);
        editor.current?.focus();
      },
      note: (note) => {
        pickPerson(note.to);
        const words = draftOfNote(note);
        const kept = value.trim();
        // Asked again while the note is already there, it stays as it is; either way the keyboard is after its words.
        const held = value.indexOf(words);
        if (held >= 0) editor.current?.write(value, held + words.length);
        else editor.current?.write(kept ? `${words}\n\n${kept}` : words, words.length);
        editor.current?.focus();
      },
    }),
    [value, appendFiles, pickPerson, replyTo],
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
  const drop = useComposerDrop((dropped) => void addFiles(dropped), props.fileSearch);
  const attachmentBlock = files.pendingReason ?? (attachments.length > 0 ? files.blocked : null);
  // A note goes where the server lets the reader post notes (`notes`), whatever holds their messages.
  const canSend = note.isNote ? Boolean(note.post) && !submitting : messageSends(props, { attachments: attachments.length, uploading, submitting, attachmentBlock });

  const canStop = turnStops(props);
  const asks = props.asks ?? [];
  const focusField = useCallback(() => editor.current?.focus(), []);
  const cluster = sendCluster({
    readOnly: Boolean(props.readOnlyReason),
    queueing: Boolean(props.queueing),
    liveByDefault: Boolean(props.liveByDefault),
    steerable: Boolean(props.steerable),
    steerReason: props.steerReason,
    queueBlocked: props.queueBlocked,
    canStop,
    hasDraft: Boolean(props.value.trim()) || attachments.length > 0 || uploading > 0,
    startsTask: props.allowEmpty,
    note: note.isNote,
    asked: asks.length > 0 ? `${props.model ? harnessShortName(props.model.agent) : "The agent"} is waiting for your answer.` : null,
  });
  const submit = (otherWay: boolean) => {
    if (!canSend) return;
    files.clearError();
    if (note.post) return submitDraft(props.value.trim(), [], note.post);
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
      <ComposerAlerts
        message={
          interrupt.error ? `Couldn’t stop the agent. ${interrupt.error.message}` : files.error || unshown(submission?.error, props.readOnlyReason) || unshown(props.error, props.readOnlyReason)
        }
        changes={props.changes}
      />
      <div ref={shell} className="composer-shell" data-dragging={drop.hover !== null || undefined} {...drop.handlers}>
        <ComposerAsk asks={asks} label={props.asksLabel} blocked={props.asksBlocked ?? null} continues={props.askContinues} fieldHasWords={Boolean(props.value.trim())} focusField={focusField} />
        {attachments.length > 0 || uploading > 0 ? <div className="composer-attachments">{files.content}</div> : null}
        <div className="composer-prompt">
          <ComposerInput
            value={props.value}
            onChange={props.onChange}
            onSubmit={submit}
            handle={drop.input}
            onFiles={addFiles}
            onReady={props.readOnlyReason || note.isNote ? undefined : readyForMessages(props.onReady, Boolean(props.notes))}
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
            people={note.people}
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
              block={note.isNote ? note.block : composerSendBlock({ disabledReason: props.readOnlyReason ?? props.disabledReason, attachmentBlock })}
              stopping={stopping}
              payer={props.sendPayer}
              onSend={submit}
              onStop={stop}
            />
          </div>
        </div>
        {drop.hover ? <ComposerDropZone hover={drop.hover} /> : null}
      </div>
    </div>
  );
  return <ComposerReadOnly.Provider value={props.readOnlyReason ?? null}>{content}</ComposerReadOnly.Provider>;
}

/**
 * The readiness hints of a draft to the agent. Where drafts can be notes, one that starts with a person's tag, as Reply
 * writes it, is a note and asks for none.
 */
function readyForMessages(onReady: ComposerProps["onReady"], notes: boolean): ComposerProps["onReady"] {
  if (!onReady || !notes) return onReady;
  return (why, message?: string) => {
    if (why !== "words" || !message || !tagsPerson(message)) onReady(why);
  };
}

/** Whether a message can go to the agent now: it has words or files, or may go empty, and nothing holds it. */
function messageSends(
  props: Pick<ComposerProps, "allowEmpty" | "value" | "busy" | "readOnlyReason" | "disabledReason">,
  { attachments, uploading, submitting, attachmentBlock }: { attachments: number; uploading: number; submitting: boolean; attachmentBlock: string | null | undefined },
): boolean {
  if (props.busy || submitting || props.readOnlyReason || props.disabledReason || attachmentBlock || uploading > 0) return false;
  return Boolean(props.allowEmpty || props.value.trim() || attachments > 0);
}

function guardHostedCommand(props: ComposerProps, held: HeldCommands): ComposerProps {
  const reason = hostedCommandReason(held, props.value);
  return reason ? { ...props, disabledReason: props.disabledReason ?? reason } : props;
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

/** Whether Stop is offered: something runs, the person may act here, and the server lets them stop it. */
function turnStops(props: Pick<ComposerProps, "readOnlyReason" | "canStopTurn" | "stopAction" | "live">): boolean {
  if (props.readOnlyReason || props.canStopTurn === false) return false;
  return Boolean(props.stopAction?.working || (!props.stopAction && props.live?.working));
}

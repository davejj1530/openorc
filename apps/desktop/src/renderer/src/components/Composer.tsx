import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ExecutionMode,
  executionMode,
  executionModeAvailable,
  executionModeSettings,
  executionModePresentation,
  executionModeUnavailable,
  type AgentKind,
  type PermissionPreset,
  type RunMode,
  type FileScope,
} from "@openorc/protocol";
import { FileText, Laptop, Lightbulb, Pencil, Plus, ShieldCheck, Square, Wand, X } from "./icons";
import { ComposerInput } from "./ComposerInput";
import { ComposerChoice } from "./ComposerChoice";
import { ComposerSendButton } from "./ComposerSendButton";
import { ComposerFooter } from "./ComposerFooter";
import { ComposerDropZone, useComposerDrop } from "./ComposerDropZone";
import { ContextUsage } from "./ContextUsage";
import { ComposerModelPicker, type ModelChoice } from "./ModelPicker";
import { Button, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useRpcMutation } from "../lib/client";
import { composerActions, composerActivity, composerSendHint } from "@openorc/client";
import { useComposerAttachments, removeAcceptedAttachments } from "../lib/composer-attachments";
import { formatBytes } from "../lib/file-imports";
import { type MentionEntry } from "../lib/composer-mentions";
import { useComposerSubmission } from "../lib/composer-submission";

export const permissionLabel: Record<PermissionPreset, string> = { review: "Review", trusted: "Workspace access", autonomous: "Autonomous" };

export type { Attachment } from "../lib/composer-attachments";

function composerDestination(props: ComposerProps): ReactNode {
  if (props.hasStarted || props.presentation === "new-thread") return null;
  if (props.children) return <div className="composer-destination">{props.children}</div>;
  if (!props.location.label) return null;
  return (
    <span className="composer-location">
      <Laptop size={14} />
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
export type SlashCommand = { name: string; hint: string; run: () => void; insert?: never; prefix?: never } | { name: string; hint: string; insert: true; prefix: "/" | "$"; run?: never };

export interface ComposerChanges {
  projectName: string;
  files: number;
  insertions: number;
  deletions: number;
  onReview: () => void;
  onCommit: () => void;
  commitDisabledReason?: string | null;
  error?: string | null;
  onRetry: () => void;
}

export interface ComposerProps {
  value: string;
  onChange: (text: string) => void;
  /** `now` requests live input; false explicitly queues during an active turn. */
  onSubmit: (text: string, attachments: string[], now: boolean) => Promise<void>;
  draftKey?: string;
  placeholder: string;
  model: ModelChoice | null;
  onModel: (choice: ModelChoice) => void;
  /** A saved team can supply its identity and lead settings in the same toolbar position. */
  modelControl?: ReactNode;
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
  /** Where the agent runs: the working folder and Git context share the footer below the input. */
  /** A caller supplying its own destination control may omit the static label. */
  location: { label: string | null; branch: string | null; directory?: string };
  /** Initial execution location is chosen before the conversation starts. */
  hasStarted?: boolean;
  /** Uncommitted changes and actions beside the working folder. */
  changes?: ComposerChanges | null;
  /** The project, only when the caller lets you change it. The name alone is TopBar’s job. */
  projectControl?: ReactNode;
  busy?: boolean;
  disabledReason?: string | null;
  /** A saved task can start from its spec without an additional message. */
  allowEmpty?: boolean;
  /** Live-run controls, when a session is open. */
  live?: { runId: string; working: boolean } | null;
  /** Team execution can stay active after its lead provider session closes. */
  stopAction?: { working: boolean; pending: boolean; onStop: () => void };
  /** Enter queues instead of sending, because the agent is mid-turn. */
  queueing?: boolean;
  /** ⌘↵ reaches the agent mid-turn. */
  steerable?: boolean;
  /** Why it cannot, when it cannot. The core words these; showing one beats a control that is simply dim. */
  steerReason?: string | null;
  /** Team chat sends live by default; ordinary solo chat keeps Enter-to-queue. */
  liveByDefault?: boolean;
  /** How full the conversation is; the ring beside send. */
  context?: { used: number; window: number | null } | null;
  onCompact?: () => void;
  compactDisabledReason?: string;
  compacting?: boolean;
  generatingImage?: boolean;
  /** Where @ file mentions search. */
  fileSearch?: FileScope;
  /** Team members `@` can address; they take the popover before file matches. */
  mentions?: MentionEntry[];
  commands?: SlashCommand[];
  autoFocus?: boolean;
  size?: "md" | "lg";
  /** The landing screen draws the roomier composer and shows where the thread works below it, not in a footer. */
  presentation?: "conversation" | "new-thread";
  error?: string | null;
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
 * bar under the text with the context ring and send at its end; the working
 * folder and Git context share the footer. @ mentions a file, / runs a command.
 */
export function Composer(props: ComposerProps) {
  const isNewThread = props.presentation === "new-thread";
  const shell = useRef<HTMLDivElement>(null);
  const files = useComposerAttachments({ draftKey: props.draftKey, disabledReason: props.attachmentsDisabledReason });
  const { attachments, uploading, addFiles, remove: removeAttachments } = files;
  const { value, onChange } = props;
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
    removeAttachments(submission.attachments);
    acknowledge();
  }, [submission, value, onChange, acknowledge, removeAttachments]);
  const drop = useComposerDrop((dropped) => void addFiles(dropped));
  const attachmentBlock = attachments.length > 0 ? props.attachmentsDisabledReason : null;
  const canSend = Boolean(props.allowEmpty || props.value.trim() || attachments.length > 0) && !props.busy && !submitting && !props.disabledReason && !attachmentBlock && uploading === 0;

  const queueing = Boolean(props.queueing);
  const canStop = Boolean(props.stopAction?.working || (!props.stopAction && props.live?.working));
  const actions = composerActions({
    queueing,
    liveByDefault: Boolean(props.liveByDefault),
    steerable: Boolean(props.steerable),
    canStop,
    hasDraft: Boolean(props.value.trim()) || attachments.length > 0 || uploading > 0,
  });
  const submit = (now = actions.sendsNow) => {
    if (!canSend) return;
    files.clearError();
    const sent = attachments.map((attachment) => attachment.path);
    const text = props.value.trim();
    setSentText(null);
    submitDraft(text, sent, async () => {
      await props.onSubmit(text, sent, now);
      removeAcceptedAttachments(props.draftKey, sent);
    });
  };

  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => void addFiles(Array.from(input.files ?? []));
    input.click();
  };

  const stopInsteadOfSend = actions.primary === "stop";
  const stopping = props.stopAction?.pending ?? interrupt.isPending;
  const activityLabel = composerActivity({ stopping, submitting, generatingImage: Boolean(props.generatingImage) });
  const sendHint = composerSendHint({
    disabledReason: props.disabledReason,
    attachmentBlock,
    liveByDefault: props.liveByDefault,
    queueing,
    steerable: props.steerable,
    steerReason: props.steerReason,
  });
  const stop = () => {
    if (stopping) return;
    if (props.stopAction) props.stopAction.onStop();
    else if (props.live) interrupt.mutate({ runId: props.live.runId });
  };

  return (
    <div className={cn("composer min-w-0", props.size === "lg" && "composer-large", isNewThread && "composer-new-thread")}>
      {interrupt.error || files.error || submission?.error || props.error ? (
        <div role="alert" className="composer-alert">
          {interrupt.error ? `Couldn’t stop the agent. ${interrupt.error.message}` : files.error || submission?.error || props.error}
        </div>
      ) : null}
      {props.changes?.error ? (
        <p role="status" className="composer-alert">
          {props.changes.error}{" "}
          <button type="button" className="underline" onClick={props.changes.onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      <div ref={shell} className="composer-shell" data-dragging={drop.dragging || undefined} {...drop.handlers}>
        {attachments.length > 0 || uploading > 0 ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.path} className="relative group">
                {attachment.url ? (
                  <img src={attachment.url} alt={attachment.name} className="composer-thumbnail" />
                ) : (
                  <span className="composer-file" title={attachment.name}>
                    <FileText size={18} className="text-ink-3" />
                    <span className="composer-file-name">{attachment.name}</span>
                    {attachment.bytes ? <span className="composer-file-size tabular">{formatBytes(attachment.bytes)}</span> : null}
                  </span>
                )}
                <button onClick={() => removeAttachments([attachment.path])} aria-label={attachment.url ? "Remove image" : `Remove ${attachment.name}`} className="composer-remove-image">
                  <X size={12} />
                </button>
              </div>
            ))}
            {uploading > 0 ? <div className="composer-thumbnail composer-uploading" /> : null}
          </div>
        ) : null}
        {/* A textarea cannot colour part of its own value, so the highlight is
            painted underneath it. The mirror holds the same text in the same
            box with transparent ink, and only the skill tokens carry a fill;
            the real characters come from the textarea sitting on top, which
            stays the only thing the caret, selection and IME ever touch. */}
        <div className="composer-prompt">
          <ComposerInput
            value={props.value}
            onChange={props.onChange}
            onSubmit={(duringTurn) => submit(actions.sendsNow || duringTurn)}
            onFiles={addFiles}
            disabled={Boolean(props.busy || submitting)}
            placeholder={props.placeholder}
            autoFocus={props.autoFocus}
            fileSearch={props.fileSearch}
            mentions={props.mentions}
            commands={props.commands}
            suggestionAnchor={shell}
            suggestionSide={isNewThread ? "bottom" : "top"}
          />
          {sent.ghost ? (
            <div key={sent.ghost.key} className="composer-sent-ghost" aria-hidden="true" onAnimationEnd={sent.clear}>
              {sent.ghost.text}
            </div>
          ) : null}
        </div>
        <div className="composer-bar">
          {/* Attach, then where and how the agent works. Chips truncate before the end group moves. */}
          <div className="composer-tools">
            <ComposerAttach onAttach={pickFiles} disabledReason={props.attachmentsDisabledReason} />
            {props.projectControl}
            {composerDestination(props)}
            {composerModelControl(props)}
            {composerModeControl(props)}
          </div>
          <div className="composer-end">
            {activityLabel ? (
              <span role="status" className="composer-activity">
                {activityLabel}
              </span>
            ) : null}
            {props.compacting ? (
              <span role="status" className="composer-activity">
                Compacting context…
              </span>
            ) : null}
            {props.context ? (
              <ContextUsage used={props.context.used} window={props.context.window} onCompact={props.onCompact} compacting={props.compacting} disabledReason={props.compactDisabledReason} />
            ) : null}
            {actions.stop ? (
              <Tooltip label="Stop this turn">
                <button onClick={stop} disabled={stopping} aria-label="Stop" className="composer-icon-button">
                  <Square size={14} />
                </button>
              </Tooltip>
            ) : null}
            {/* Send now (also ⌘↵) appears only when the turn can take it.
                Disabled controls drop their pointer events, so a dim button
                could never show why it was dim. The reason goes on the queue
                button instead, which is enabled and therefore hoverable. */}
            {actions.sendNow ? (
              <Tooltip label="Say it during this turn">
                <button onClick={() => void submit(true)} disabled={!canSend} aria-label="Send now" className="composer-send-now">
                  Send now
                </button>
              </Tooltip>
            ) : null}
            {actions.queue ? (
              <Tooltip label="Queue for after this turn">
                <Button size="sm" variant="ghost" disabled={!canSend} onClick={() => void submit(false)}>
                  Queue
                </Button>
              </Tooltip>
            ) : null}
            <ComposerSendButton
              state={actions.primary}
              disabled={stopInsteadOfSend ? stopping : !canSend}
              hint={stopInsteadOfSend ? "Stop this turn" : sendHint}
              onClick={stopInsteadOfSend ? stop : () => void submit()}
            />
          </div>
        </div>
        {drop.dragging ? <ComposerDropZone count={drop.count} /> : null}
      </div>
      {isNewThread ? null : <ComposerFooter location={props.location} changes={props.changes} />}
    </div>
  );
}

function ComposerAttach({ onAttach, disabledReason }: { onAttach: () => void; disabledReason?: string | null }) {
  return (
    <Tooltip label={disabledReason ?? "Attach files"}>
      <button onClick={onAttach} disabled={Boolean(disabledReason)} aria-label="Attach file" className="composer-icon-button composer-attach">
        <Plus size={16} />
      </button>
    </Tooltip>
  );
}

function composerModelControl(props: ComposerProps): ReactNode {
  const unavailable = props.model ? executionModeUnavailable(props.model.agent, executionMode(props.mode, props.permission)) : null;
  return (
    <>
      {props.modelControl ?? <ComposerModelPicker value={props.model} onChange={props.onModel} />}
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

const modeIcons: Record<ExecutionMode, typeof ShieldCheck> = { plan: Lightbulb, review: ShieldCheck, trusted: Pencil, autonomous: Wand };

/** Every mode keeps its label for the trigger; the menu offers only the ones the agent can run. */
function modeOptions(agent: AgentKind | undefined) {
  return ExecutionMode.options.map((value) => ({ value, ...executionModePresentation(agent, value), icon: modeIcons[value], hidden: !executionModeAvailable(agent, value) }));
}

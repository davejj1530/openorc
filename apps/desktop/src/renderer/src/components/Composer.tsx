import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ExecutionMode, executionMode, executionModeSettings, executionModePresentation, executionModeUnavailable, type PermissionPreset, type RunMode } from "@openorc/protocol";
import { ArrowUp, ChevronDown, Clock, FileText, GitBranch, Laptop, Plus, Square, X } from "./icons";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ComposerInput } from "./ComposerInput";
import { ChangesShoulder } from "./ChangesShoulder";
import { ComposerModelPicker, type ModelChoice } from "./ModelPicker";
import { Button, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useRpcMutation } from "../lib/query";
import { useComposerAttachments, removeAcceptedAttachments } from "../lib/composer-attachments";
import { formatTokens } from "../lib/time";
import { formatBytes } from "../lib/file-imports";
import { type MentionEntry } from "../lib/composer-mentions";
import { useComposerSubmission } from "../lib/composer-submission";
import { composerActivity, composerSendHint } from "../lib/composer-presentation";
import { CoversPreview } from "../lib/browser-preview";

export const permissionLabel: Record<PermissionPreset, string> = { review: "Review", trusted: "Workspace access", autonomous: "Autonomous" };

export type { Attachment } from "../lib/composer-attachments";

function composerDestination(props: ComposerProps): ReactNode {
  if (props.hasStarted) return null;
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
  /** Where the agent runs: checkout and branch beside the mode, or a working folder above the input. */
  /** A caller supplying its own destination control may omit the static label. */
  location: { label: string | null; branch: string | null; directory?: string };
  /** Initial execution location is chosen before the conversation starts. */
  hasStarted?: boolean;
  /** Uncommitted changes and actions in the shell’s original top rail. */
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
  /** How full the conversation is; the ring beside the model. */
  context?: { used: number; window: number | null } | null;
  onCompact?: () => void;
  compactDisabledReason?: string;
  compacting?: boolean;
  generatingImage?: boolean;
  /** For @ file mentions. */
  projectId?: string;
  /** Team members `@` can address; they take the popover before file matches. */
  mentions?: MentionEntry[];
  commands?: SlashCommand[];
  autoFocus?: boolean;
  size?: "md" | "lg";
  error?: string | null;
  children?: ReactNode;
}

/**
 * The one composer, for the landing screen and every conversation. Files
 * paste or drop in and ride along with the prompt, images as thumbnails and
 * everything else as a named chip; the model, effort, mode,
 * and permission live under the text; uncommitted changes sit above it. @
 * mentions a file, / runs a command, and the ring says how full the
 * conversation is.
 */
export function Composer(props: ComposerProps) {
  const files = useComposerAttachments({ draftKey: props.draftKey, disabledReason: props.attachmentsDisabledReason });
  const { attachments, uploading, addFiles, remove: removeAttachments } = files;
  const { value, onChange } = props;
  const interrupt = useRpcMutation("runs.interrupt");
  const { submission, submit: submitDraft, acknowledge } = useComposerSubmission(props.draftKey);
  const submitting = submission?.status === "pending";
  useEffect(() => {
    if (submission?.status !== "accepted") return;
    if (value.trim() === submission.text) onChange("");
    removeAttachments(submission.attachments);
    acknowledge();
  }, [submission, value, onChange, acknowledge, removeAttachments]);
  const [dragging, setDragging] = useState(false);
  const attachmentBlock = attachments.length > 0 ? props.attachmentsDisabledReason : null;
  const canSend = Boolean(props.allowEmpty || props.value.trim() || attachments.length > 0) && !props.busy && !submitting && !props.disabledReason && !attachmentBlock && uploading === 0;

  const changed = Boolean(props.changes && props.changes.files > 0);
  const submit = (now = Boolean(props.liveByDefault && queueing)) => {
    if (!canSend) return;
    files.clearError();
    const sent = attachments.map((attachment) => attachment.path);
    const text = props.value.trim();
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

  const queueing = Boolean(props.queueing);
  const canStop = Boolean(props.stopAction?.working || (!props.stopAction && props.live?.working));
  const stopInsteadOfSend = canStop && !props.value.trim() && attachments.length === 0 && uploading === 0;
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
    <div className={cn("composer min-w-0", props.size === "lg" && "composer-large")}>
      {interrupt.error || files.error || submission?.error || props.error ? (
        <div role="alert" className="mb-2 text-sm text-bad break-words">
          {interrupt.error ? `Couldn’t stop the agent. ${interrupt.error.message}` : files.error || submission?.error || props.error}
        </div>
      ) : null}
      {props.changes?.error ? (
        <p role="status" className="mb-2 text-sm text-bad">
          {props.changes.error}{" "}
          <button type="button" className="underline" onClick={props.changes.onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      {changed && props.changes ? (
        <section className="composer-changes" aria-label="Uncommitted changes">
          <ChangesShoulder />
          <div className="composer-changes-body">
            <div className="composer-changes-identity">
              <span className="composer-changes-project" title={props.changes.projectName}>
                {props.changes.projectName}
              </span>
              {props.location.branch ? (
                <span className="composer-changes-branch" title={props.location.branch}>
                  <GitBranch size={14} />
                  <span>{props.location.branch}</span>
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="composer-changes-summary"
              onClick={props.changes.onReview}
              aria-label={`Review ${props.changes.files} changed ${props.changes.files === 1 ? "file" : "files"}, ${props.changes.insertions} added and ${props.changes.deletions} removed lines`}
            >
              {props.changes.insertions + props.changes.deletions > 0 ? (
                <>
                  {props.changes.insertions > 0 ? <span className="text-ok">+{props.changes.insertions.toLocaleString()}</span> : null}
                  {props.changes.deletions > 0 ? <span className="text-bad">−{props.changes.deletions.toLocaleString()}</span> : null}
                </>
              ) : (
                <span>
                  {props.changes.files} {props.changes.files === 1 ? "file" : "files"}
                </span>
              )}
            </button>
            <Tooltip label={props.changes.commitDisabledReason ?? "Commit changes"}>
              <span className="composer-changes-commit-wrap">
                <button type="button" className="composer-changes-commit" aria-label="Commit changes" disabled={Boolean(props.changes.commitDisabledReason)} onClick={props.changes.onCommit}>
                  Commit<span className="composer-commit-suffix"> changes</span>
                </button>
              </span>
            </Tooltip>
          </div>
        </section>
      ) : null}
      <div
        className="composer-shell relative border"
        data-dragging={dragging || undefined}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
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
            {uploading > 0 ? <div className="composer-thumbnail border border-dashed border-line-strong animate-pulse" /> : null}
          </div>
        ) : null}
        {/* A textarea cannot colour part of its own value, so the highlight is
            painted underneath it. The mirror holds the same text in the same
            box with transparent ink, and only the skill tokens carry a fill;
            the real characters come from the textarea sitting on top, which
            stays the only thing the caret, selection and IME ever touch. */}
        {props.location.directory ? (
          <div className="composer-rail">
            {props.location.directory ? (
              <span className="inline-flex items-center gap-1 min-w-0 truncate" title={props.location.directory}>
                <Laptop size={14} className="shrink-0" />
                <span className="truncate">{props.location.directory}</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <ComposerInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={(duringTurn) => submit(Boolean(props.liveByDefault && queueing) || duringTurn)}
          onFiles={addFiles}
          disabled={Boolean(props.busy || submitting)}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          projectId={props.projectId}
          mentions={props.mentions}
          commands={props.commands}
        />
        {/* Workspace context and settings share the shell's bottom row. */}
        <div className="composer-foot">
          <div className="composer-lead">
            <Tooltip label={props.attachmentsDisabledReason ?? "Attach a file. Paste or drop works too."}>
              <button onClick={pickFiles} disabled={Boolean(props.attachmentsDisabledReason)} aria-label="Attach file" className="composer-icon-button">
                <Plus size={16} />
              </button>
            </Tooltip>
          </div>
          {/* Metadata truncates first; narrow layouts let the action group use a second row. */}
          <div className="composer-meta">
            {props.projectControl}
            {composerDestination(props)}
            {!changed && props.location.branch ? (
              <span className="composer-branch" title={props.location.branch}>
                <GitBranch size={14} />
                <span>{props.location.branch}</span>
              </span>
            ) : null}
            <ComposerChoice
              ariaLabel="Mode"
              value={executionMode(props.mode, props.permission)}
              options={ExecutionMode.options.map((value) => ({ value, ...executionModePresentation(props.model?.agent, value) }))}
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
          </div>
          <div className="composer-actions">
            {props.context ? (
              <ContextRing used={props.context.used} window={props.context.window} onCompact={props.onCompact} compacting={props.compacting} disabledReason={props.compactDisabledReason} />
            ) : null}
            {activityLabel ? (
              <span role="status" className="text-xs text-ink-3 px-1">
                {activityLabel}
              </span>
            ) : null}
            {props.compacting ? (
              <span role="status" className="text-xs text-ink-3 px-1">
                Compacting context…
              </span>
            ) : null}
            {props.modelControl ?? <ComposerModelPicker value={props.model} onChange={props.onModel} />}
            {props.model && executionModeUnavailable(props.model.agent, executionMode(props.mode, props.permission)) ? (
              <Tooltip label={executionModeUnavailable(props.model.agent, executionMode(props.mode, props.permission))!}>
                <span className="text-xs text-ink-3" role="status">
                  Mode unavailable
                </span>
              </Tooltip>
            ) : null}
            {canStop && !stopInsteadOfSend ? (
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
            {!stopInsteadOfSend && !props.liveByDefault && queueing && props.steerable ? (
              <Tooltip label="Say it during this turn (⌘↵)">
                <button onClick={() => void submit(true)} disabled={!canSend} aria-label="Send now" className="composer-send-now">
                  Send now
                </button>
              </Tooltip>
            ) : null}
            {!stopInsteadOfSend && props.liveByDefault && queueing ? (
              <Tooltip label="Queue for after this turn">
                <Button size="sm" variant="ghost" disabled={!canSend} onClick={() => void submit(false)}>
                  Queue
                </Button>
              </Tooltip>
            ) : null}
            {stopInsteadOfSend ? (
              <Tooltip label="Stop this turn">
                <button onClick={stop} disabled={stopping} aria-label="Stop" className="composer-send">
                  <Square size={16} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label={sendHint}>
                <button
                  onClick={() => void submit()}
                  disabled={!canSend}
                  aria-label={queueing && !props.liveByDefault ? "Queue" : "Send"}
                  className={cn("composer-send", queueing && !props.liveByDefault && "composer-send-queued")}
                >
                  {queueing && !props.liveByDefault ? <Clock size={16} /> : <ArrowUp size={16} />}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Usage stays inspectable even while compaction is unavailable. Only the explicit action compacts. */
function ContextRing({ used, window, onCompact, compacting, disabledReason }: { used: number; window: number | null; onCompact?: () => void; compacting?: boolean; disabledReason?: string }) {
  const fraction = window ? Math.min(1, used / window) : 0;
  const r = 6;
  const c = 2 * Math.PI * r;
  let tone = "text-ink-3";
  if (fraction > 0.85) tone = "text-bad";
  else if (fraction > 0.6) tone = "text-warn";
  return (
    <Popover.Root>
      <Popover.Trigger aria-label="Context usage" className={cn("composer-context", tone)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${c * fraction} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
        </svg>
        <span>{window ? `${Math.round(fraction * 100)}%` : formatTokens(used)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={12}>
          <Popover.Popup className="composer-context-popup">
            <Popover.Title className="text-base font-medium text-ink">Context usage</Popover.Title>
            <Popover.Description className="mt-1 text-sm text-ink-2">Context is the messages, instructions, and tool results the model can use in this conversation.</Popover.Description>
            <dl className="composer-context-stats">
              <div>
                <dt>Used</dt>
                <dd>
                  {used.toLocaleString()} tokens{window ? ` (${Math.round(fraction * 100)}%)` : ""}
                </dd>
              </div>
              {window ? (
                <>
                  <div>
                    <dt>Available</dt>
                    <dd>{Math.max(0, window - used).toLocaleString()} tokens</dd>
                  </div>
                  <div>
                    <dt>Context window</dt>
                    <dd>{window.toLocaleString()} tokens</dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt>Context window</dt>
                  <dd>Not reported</dd>
                </div>
              )}
            </dl>
            <div className="composer-context-compact">
              <p className="text-sm text-ink-2">Compacting summarizes earlier messages to free up space. Some detail may be lost.</p>
              <Button size="sm" variant="secondary" disabled={!onCompact || compacting || Boolean(disabledReason)} onClick={onCompact}>
                {compacting ? "Compacting…" : "Compact context"}
              </Button>
              {compacting || !onCompact || disabledReason ? (
                <p role="status" className="text-xs text-ink-3">
                  {compacting ? "Compacting context. New messages will be queued." : (disabledReason ?? "Compaction is unavailable for this conversation right now.")}
                </p>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One choice control for the composer foot. Every picker down there is this object:
 * transparent at rest, an ink wash on hover and while open, the current value in --ink and a
 * small chevron. Mode, destination and the model all read it, so a two-up segmented control
 * never has to spend the width of the option you did not pick.
 */
export function ComposerChoice<T extends string>({
  value,
  options,
  onChange,
  disabled,
  disabledReason,
  describedBy,
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; hint?: string; icon?: ComponentType<{ size?: number }> }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  disabledReason?: string;
  describedBy?: string;
  ariaLabel: string;
  className?: string;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  const Icon = current?.icon;
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        aria-describedby={describedBy}
        title={disabled ? disabledReason : current?.hint}
        className={cn("composer-picker", className)}
      >
        {Icon ? <Icon size={14} /> : null}
        <span className="composer-picker-value">{current?.label ?? value}</span>
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner side="top" align="end" sideOffset={6} collisionPadding={8}>
          <Menu.Popup className="menu-popup w-64 rounded-lg border border-line bg-surface p-1 shadow-panel outline-none">
            {options.map((o) => (
              <Menu.Item key={o.value} className="grid gap-0.5 px-2 py-1.5 rounded-md cursor-pointer data-[highlighted]:bg-surface-2 outline-none" onClick={() => onChange(o.value)}>
                <span className={cn("text-base", value === o.value ? "text-ink font-medium" : "text-ink-2")}>{o.label}</span>
                {o.hint ? <span className="text-xs text-ink-3">{o.hint}</span> : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

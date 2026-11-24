import { Popover } from "@base-ui/react/popover";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { DEFAULT_SPEECH_MODEL, type SpeechModelState } from "../../../shared/dictation";
import { CoversPreview } from "../lib/browser-preview";
import {
  cancelDictation,
  connectDictation,
  dismissDictationNotice,
  finishDictation,
  registerDictationTarget,
  startDictation,
  useDictation,
  type DictationNotice,
  type DictationPhase,
} from "../lib/dictation/dictation";
import { floatingGround } from "../lib/use-anchor-ground";
import type { ComposerEditorHandle } from "./composer-editor/ComposerEditor";
import { useLatest } from "./composer-editor/shared";
import { useComposerControl } from "./composer-read-only";
import { DictationMeter } from "./DictationMeter";
import { Check, Mic, X } from "./icons";
import { Button } from "./ui";

export interface ComposerDictationState {
  owner: string;
  /** Where this composer's recording is; null while it has none. */
  phase: DictationPhase | null;
  toggle: () => void;
}

const typingElsewhere = (target: EventTarget | null, shell: HTMLElement | null) =>
  target instanceof HTMLElement && !shell?.contains(target) && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Dictation for one composer. Spoken words are written into its draft where the caret was, as they are heard; the
 * draft takes no typing meanwhile. Escape takes the words back out, and the keyboard returns to the draft however the
 * recording ends. A draft that becomes another conversation's ends the recording, since its words belong to the first.
 */
export function useComposerDictation(editor: RefObject<ComposerEditorHandle | null>, shell: RefObject<HTMLElement | null>, draftKey: string | undefined): ComposerDictationState {
  const owner = useId();
  const phase = useDictation((s) => (s.take?.owner === owner ? s.take.phase : null));
  const toggle = useCallback(() => {
    if (useDictation.getState().take?.owner === owner) void finishDictation();
    else void startDictation(owner, () => editor.current?.speak());
  }, [owner, editor]);
  useEffect(() => (connectDictation() ? registerDictationTarget(owner, { shell, toggle }) : undefined), [owner, shell, toggle]);
  useEffect(
    () => () => {
      if (useDictation.getState().take?.owner === owner) cancelDictation();
    },
    [owner, draftKey],
  );
  const was = useRef(phase);
  useEffect(() => {
    if (was.current && !phase) editor.current?.focus();
    was.current = phase;
  }, [phase, editor]);
  useEffect(() => {
    if (!phase) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || typingElsewhere(event.target, shell.current)) return;
      cancelDictation();
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, shell]);
  return { owner, phase, toggle };
}

/**
 * Sending while dictating. A send asked for mid-recording, by its button or by Enter, finishes the recording first and
 * goes once the last words are in the draft, the way it was asked for: Enter's, or the other with Command or Control.
 * A recording that is cancelled or fails sends nothing. The draft has no keyboard while it is spoken into, so Enter is
 * heard on the window.
 */
export function useDictatedSend(dictation: ComposerDictationState, shell: RefObject<HTMLElement | null>, submit: (otherWay: boolean) => void): (otherWay: boolean) => void {
  const latest = useLatest(submit);
  // The send that waited, handed on through a render so it goes with the draft as the last words left it.
  const [due, setDue] = useState<{ otherWay: boolean } | null>(null);
  const gone = useRef(due);
  useEffect(() => {
    if (!due || gone.current === due) return;
    gone.current = due;
    latest.current(due.otherWay);
  }, [due, latest]);
  const dictating = Boolean(dictation.phase);
  const send = useCallback(
    (otherWay: boolean) => {
      if (!dictating) return latest.current(otherWay);
      void finishDictation().then((finished) => {
        if (finished) setDue({ otherWay });
      });
    },
    [dictating, latest],
  );
  useEffect(() => {
    if (!dictating) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || typingElsewhere(event.target, shell.current)) return;
      event.preventDefault();
      event.stopPropagation();
      send(event.metaKey || event.ctrlKey);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dictating, shell, send]);
  return send;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** The model on its way: how far, and a way to stop. */
function ModelDownload({ received }: { received: number }) {
  const model = DEFAULT_SPEECH_MODEL;
  return (
    <>
      <Popover.Title className="composer-dictate-title">Downloading the speech model</Popover.Title>
      <progress className="app-update-progress" value={received} max={model.bytes} aria-label="Speech model download" />
      <div className="composer-dictate-row">
        <span className="tabular text-ink-3">
          {megabytes(received)} of {megabytes(model.bytes)}
        </span>
        <Button size="sm" onClick={() => void window.openorc.dictation.cancelDownload(model.id)}>
          Cancel
        </Button>
      </div>
    </>
  );
}

/** The model is not on this computer: what it costs to get, or why getting it stopped. */
function ModelOffer({ model }: { model: SpeechModelState | undefined }) {
  if (model?.phase === "downloading") return <ModelDownload received={model.received} />;
  const failed = model?.phase === "failed" ? model.reason : null;
  return (
    <>
      <Popover.Title className="composer-dictate-title">Dictation needs a speech model</Popover.Title>
      <Popover.Description className="text-ink-3">{failed ?? `${megabytes(DEFAULT_SPEECH_MODEL.bytes)}. Your voice stays on this computer.`}</Popover.Description>
      <div className="composer-dictate-row">
        <Button size="sm" variant="primary" onClick={() => void window.openorc.dictation.download(DEFAULT_SPEECH_MODEL.id)}>
          {failed ? "Try again" : "Download"}
        </Button>
      </div>
    </>
  );
}

const SETTINGS_WORDS: Record<string, string> = { darwin: "Open System Settings", win32: "Open Settings" };

function MicrophoneRefused() {
  const open = SETTINGS_WORDS[window.openorc.platform];
  return (
    <>
      <Popover.Title className="composer-dictate-title">OpenOrc can’t use the microphone</Popover.Title>
      <Popover.Description className="text-ink-3">Allow it in your system’s privacy settings, then dictate again.</Popover.Description>
      {open ? (
        <div className="composer-dictate-row">
          <Button size="sm" onClick={() => window.openorc.dictation.openMicrophoneSettings()}>
            {open}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function NoticeWords({ notice, model }: { notice: DictationNotice; model: SpeechModelState | undefined }) {
  if (notice.kind === "model") return <ModelOffer model={model} />;
  if (notice.kind === "microphone") return <MicrophoneRefused />;
  return <Popover.Title className="composer-dictate-title">{notice.reason}</Popover.Title>;
}

/**
 * The composer's microphone, beside send. At rest it is the glyph. Dictating, the key opens into a pill: the voice as
 * it was just heard, how long it has listened, and a check where the microphone was, since pressing it finishes.
 * Cancel arrives beside it, so taking the words back is in reach without knowing Escape does it. What the microphone
 * has to say opens above it: the model to download the first time, the microphone refused, or why a recording stopped.
 */
export function ComposerDictation({ dictation }: { dictation: ComposerDictationState }) {
  const control = useComposerControl();
  const button = useRef<HTMLButtonElement>(null);
  const model = useDictation((s) => s.models[DEFAULT_SPEECH_MODEL.id]);
  const notice = useDictation((s) => (s.notice?.owner === dictation.owner ? s.notice : null));
  const { phase } = dictation;
  // The download the person asked for here has arrived: the offer has nothing left to say.
  const arrived = notice?.kind === "model" && model?.phase === "ready";
  useEffect(() => {
    if (arrived) dismissDictationNotice();
  }, [arrived]);
  if (!window.openorc?.dictation) return null;
  const label = phase ? "Finish dictating" : "Dictate";
  return (
    <>
      <div className="composer-dictate-group" data-state={phase ?? undefined}>
        <button type="button" className="composer-dictate-cancel" aria-label="Cancel dictation" data-tip="Cancel" disabled={!phase} onClick={cancelDictation}>
          <X size={14} />
        </button>
        <button
          ref={button}
          type="button"
          className="composer-dictate"
          data-state={phase ?? undefined}
          aria-label={label}
          aria-pressed={Boolean(phase)}
          data-tip={control.reason ?? label}
          disabled={control.disabled || phase === "finishing"}
          onClick={dictation.toggle}
        >
          <span className="composer-dictate-live" aria-hidden="true">
            <span>
              <DictationMeter active={Boolean(phase)} />
            </span>
          </span>
          <span className="composer-dictate-glyph" aria-hidden="true">
            <span data-layer="rest">
              <Mic size={16} />
            </span>
            <span data-layer="live">
              <Check size={16} />
            </span>
          </span>
        </button>
      </div>
      <Popover.Root
        open={Boolean(notice)}
        onOpenChange={(open) => {
          if (!open) dismissDictationNotice();
        }}
      >
        <Popover.Portal>
          <CoversPreview />
          <Popover.Positioner anchor={button} side="top" align="end" sideOffset={6} collisionPadding={12}>
            <Popover.Popup ref={floatingGround} className="floating-popover composer-dictate-popup">
              {notice ? <NoticeWords notice={notice} model={model} /> : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

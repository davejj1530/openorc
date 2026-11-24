import { create } from "zustand";
import { DEFAULT_SPEECH_MODEL, type DictationEvent, type SpeechModelState } from "../../../../shared/dictation";
import type { Spoken } from "../../components/composer-editor/ComposerEditor";
import { captureMicrophone, loudness, type Capture } from "./capture";

/** A recording opens the microphone, hears the person, then waits for the model's last words. */
export type DictationPhase = "starting" | "listening" | "finishing";

/** What a composer's microphone has to say: the model is not here yet, the microphone is refused, or a recording stopped. */
export type DictationNotice = { kind: "model" } | { kind: "microphone" } | { kind: "failed"; reason: string };

interface DictationState {
  models: Record<string, SpeechModelState>;
  /** The one recording in progress, and the composer it writes in. */
  take: { id: string; owner: string; phase: DictationPhase } | null;
  notice: ({ owner: string } & DictationNotice) | null;
  /** The input device dictation records from; null follows the system's. */
  microphone: string | null;
}

const KEY = "openorc.dictation";

function savedMicrophone(): string | null {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as { microphone?: string }).microphone ?? null;
  } catch {
    return null;
  }
}

export const useDictation = create<DictationState>(() => ({ models: {}, take: null, notice: null, microphone: savedMicrophone() }));

export function setMicrophone(microphone: string | null): void {
  useDictation.setState({ microphone });
  try {
    localStorage.setItem(KEY, JSON.stringify({ microphone }));
  } catch {
    // The choice still holds for this window.
  }
}

/** A forgotten recording ends by itself, keeping what it heard. */
const LIMIT_MS = 10 * 60_000;
/** The last word is still on its way through the microphone when the person stops. */
const TAIL_MS = 250;

interface Recording {
  id: string;
  owner: string;
  capture: Capture | null;
  spoken: Spoken | null;
  limit: ReturnType<typeof setTimeout> | null;
}

let recording: Recording | null = null;
const meters = new Set<(level: number) => void>();

/** How loud the microphone is, block by block, for whoever draws it; returns the unsubscribe. */
export function onLevel(meter: (level: number) => void): () => void {
  meters.add(meter);
  return () => void meters.delete(meter);
}

class MicrophoneRefused extends Error {}

function noticeOf(error: unknown): DictationNotice {
  const name = error instanceof DOMException ? error.name : "";
  if (error instanceof MicrophoneRefused || name === "NotAllowedError") return { kind: "microphone" };
  if (name === "NotFoundError") return { kind: "failed", reason: "No microphone was found." };
  return { kind: "failed", reason: "Dictation couldn’t start." };
}

/** Lets go of the microphone and the timer; the recording is no longer the one in progress. */
function release(current: Recording): void {
  if (recording === current) recording = null;
  current.capture?.stop();
  current.capture = null;
  if (current.limit) clearTimeout(current.limit);
}

function heard(event: DictationEvent): void {
  const current = recording;
  if (!current || event.id !== current.id) return;
  if (event.type !== "failed") current.spoken?.say(event.words);
  if (event.type === "words") return;
  release(current);
  current.spoken?.end(true);
  useDictation.setState({ take: null, notice: event.type === "failed" ? { owner: current.owner, kind: "failed", reason: event.reason } : null });
}

let connected = false;

/** Follows the models and recordings main reports. A window without dictation, as in a test, stays as it is. */
export function connectDictation(): boolean {
  const api = window.openorc?.dictation;
  if (!api || connected) return Boolean(api);
  connected = true;
  void api.models().then((models) => useDictation.setState({ models }));
  api.onModel((model, state) => useDictation.setState((s) => ({ models: { ...s.models, [model]: state } })));
  api.onEvent(heard);
  window.addEventListener("pagehide", cancelDictation);
  return true;
}

/**
 * Starts a recording for one composer: `speak` opens the place in its draft the words go. Without the model, the
 * composer is told to offer it instead. The speech process starts before the microphone opens, so the model loads
 * while the person begins to talk, and what they said meanwhile is heard once it has.
 */
export async function startDictation(owner: string, speak: () => Spoken | undefined): Promise<void> {
  const api = window.openorc.dictation;
  const { take, models, microphone } = useDictation.getState();
  if (take) return;
  if (models[DEFAULT_SPEECH_MODEL.id]?.phase !== "ready") {
    useDictation.setState({ notice: { owner, kind: "model" } });
    return;
  }
  const id = crypto.randomUUID();
  const current: Recording = { id, owner, capture: null, spoken: null, limit: null };
  recording = current;
  useDictation.setState({ take: { id, owner, phase: "starting" }, notice: null });
  try {
    if ((await api.microphone()) === "denied") throw new MicrophoneRefused();
    if (recording !== current) return;
    await api.start(id, DEFAULT_SPEECH_MODEL.id);
    const capture = await captureMicrophone(microphone, (pcm) => {
      api.audio(id, pcm);
      const level = loudness(pcm);
      for (const meter of meters) meter(level);
    });
    if (recording !== current) {
      capture.stop();
      api.cancel(id);
      return;
    }
    current.capture = capture;
    current.spoken = speak() ?? null;
    current.limit = setTimeout(finishDictation, LIMIT_MS);
    useDictation.setState({ take: { id, owner, phase: "listening" } });
  } catch (error) {
    if (recording !== current) return;
    release(current);
    api.cancel(id);
    useDictation.setState({ take: null, notice: { owner, ...noticeOf(error) } });
  }
}

/** Stops listening and waits for the model's last words, which end the recording when they arrive. */
export function finishDictation(): void {
  const current = recording;
  const take = useDictation.getState().take;
  if (!current || !take) return;
  if (take.phase === "starting") return cancelDictation();
  if (take.phase !== "listening") return;
  useDictation.setState({ take: { ...take, phase: "finishing" } });
  setTimeout(() => {
    if (recording !== current) return;
    current.capture?.stop();
    current.capture = null;
    window.openorc.dictation.finish(current.id);
  }, TAIL_MS);
}

/** Ends the recording and takes its words back out of the draft. */
export function cancelDictation(): void {
  const current = recording;
  if (!current) return;
  release(current);
  window.openorc.dictation.cancel(current.id);
  current.spoken?.end(false);
  useDictation.setState({ take: null });
}

/** A composer that can be dictated into: where it is on screen, and how its recording starts and finishes. */
interface DictationTarget {
  shell: { readonly current: HTMLElement | null };
  toggle: () => void;
}

const targets = new Map<string, DictationTarget>();

export function registerDictationTarget(owner: string, target: DictationTarget): () => void {
  targets.set(owner, target);
  return () => void targets.delete(owner);
}

/** Starts or finishes dictation from the keyboard: in the composer recording, else the one in focus, else the first on screen. */
export function toggleDictation(): boolean {
  const recorder = useDictation.getState().take?.owner;
  const shown = [...targets.entries()].filter(([, target]) => target.shell.current?.isConnected);
  const found = shown.find(([owner]) => owner === recorder) ?? shown.find(([, target]) => target.shell.current?.contains(document.activeElement)) ?? shown[0];
  found?.[1].toggle();
  return Boolean(found);
}

export function dismissDictationNotice(): void {
  useDictation.setState({ notice: null });
}

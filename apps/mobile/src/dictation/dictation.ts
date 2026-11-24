import { createStore, type StoreApi } from "zustand/vanilla";
import { hear, HEARD_NOTHING, heardWords, type Heard } from "./spoken";

/** Where a recording is: asking for the microphone, hearing, or taking in its last words. */
export type DictationPhase = "starting" | "listening" | "finishing";

/**
 * Why the microphone did not start, or stopped: the person refused it, the device has no speech model of its own for
 * their language, or the recording broke off.
 */
export type DictationNoticeKind = "microphone" | "unavailable" | "stopped";

/** A draft being spoken into: `say` rewrites the words as more is heard, `end` keeps them or takes them back out. */
export interface Spoken {
  say: (words: string) => void;
  end: (keep: boolean) => void;
}

/** What a recognizer tells of a recording, in the order it happens; `end` is always last. */
export interface RecognizerEvents {
  start: () => void;
  /** The words of the stretch being heard, again as they are made out and once more when they settle. */
  words: (transcript: string, final: boolean) => void;
  /** How loud the microphone hears, from 0 for silence to 1. */
  level: (level: number) => void;
  error: (code: string) => void;
  end: () => void;
}

/** The device's own speech recognition, kept on the device. */
export interface Recognizer {
  /** Whether the microphone may be used, asking the person the first time. */
  microphone: () => Promise<boolean>;
  /** The language to recognize in; none where the device has no model of its own for the person's language. */
  language: () => Promise<string | null>;
  start: (language: string, events: RecognizerEvents) => void;
  /** Stops hearing and settles the last words. */
  stop: () => void;
  /** Stops at once. */
  abort: () => void;
}

export interface DictationState {
  /** The one recording, and whose it is; `since` is when it began to hear. */
  take: { owner: string; phase: DictationPhase; since: number | null } | null;
  notice: { owner: string; kind: DictationNoticeKind } | null;
}

interface Session {
  owner: string;
  spoken: Spoken | null;
  heard: Heard;
  waiting: ((kept: boolean) => void)[];
  giveUp: ReturnType<typeof setTimeout> | null;
}

/** A recognizer that takes its last words longer than this is not waited for: what it settled so far is kept. */
const LAST_WORDS_MS = 2500;
/** The codes a recognizer ends with that are no failure: the person stopped it, or said nothing. */
const QUIET_ENDS = new Set(["aborted", "no-speech", "speech-timeout"]);
const REFUSALS = new Set(["not-allowed"]);
const UNAVAILABLE = new Set(["service-not-allowed", "language-not-supported"]);

/** What a recognizer's failure tells the person: the microphone refused, no model on the device, or a recording broken off. */
function failureOf(code: string): DictationNoticeKind {
  if (REFUSALS.has(code)) return "microphone";
  return UNAVAILABLE.has(code) ? "unavailable" : "stopped";
}

export interface Dictation {
  store: StoreApi<DictationState>;
  /** Starts `owner`'s recording into the draft `speak` opens. Another owner's recording is cancelled first. */
  start: (owner: string, speak: () => Spoken) => Promise<void>;
  /** Stops hearing, and tells once the last words are in the draft. False where there was nothing to keep them in. */
  finish: () => Promise<boolean>;
  /** Stops at once and takes the words back out. */
  cancel: () => void;
  dismissNotice: () => void;
  /** The loudness now, from 0 to 1, for a meter that reads it a frame at a time. */
  level: () => number;
}

/**
 * Dictation for the whole app: one recording at a time, into the draft of the composer that started it. The words
 * are recognized by the device itself, so a recording needs nothing but the microphone.
 */
export function createDictation(recognizer: Recognizer, now: () => number = Date.now): Dictation {
  const store = createStore<DictationState>(() => ({ take: null, notice: null }));
  let session: Session | null = null;
  let level = 0;

  const close = (mine: Session, kept: boolean, notice: DictationNoticeKind | null = null) => {
    if (session !== mine) return;
    session = null;
    level = 0;
    if (mine.giveUp) clearTimeout(mine.giveUp);
    mine.spoken?.end(kept);
    store.setState({ take: null, notice: notice ? { owner: mine.owner, kind: notice } : store.getState().notice });
    mine.waiting.forEach((tell) => tell(kept));
  };

  const cancel = () => {
    const mine = session;
    if (!mine) return;
    close(mine, false);
    recognizer.abort();
  };

  return {
    store,
    async start(owner, speak) {
      if (session?.owner === owner) return;
      cancel();
      const mine: Session = { owner, spoken: null, heard: HEARD_NOTHING, waiting: [], giveUp: null };
      session = mine;
      store.setState({ take: { owner, phase: "starting", since: null }, notice: null });
      if (!(await recognizer.microphone())) return close(mine, false, "microphone");
      if (session !== mine) return;
      const language = await recognizer.language();
      if (session !== mine) return;
      if (!language) return close(mine, false, "unavailable");
      mine.spoken = speak();
      let failure: DictationNoticeKind | null = null;
      recognizer.start(language, {
        start: () => {
          const take = store.getState().take;
          if (session === mine && take?.phase === "starting") store.setState({ take: { ...take, phase: "listening", since: now() } });
        },
        words: (transcript, final) => {
          if (session !== mine) return;
          mine.heard = hear(mine.heard, transcript, final);
          mine.spoken?.say(heardWords(mine.heard));
        },
        level: (heard) => {
          if (session === mine) level = heard;
        },
        error: (code) => {
          if (QUIET_ENDS.has(code)) return;
          failure = failureOf(code);
        },
        // What was heard before a recording broke off stays; a recording that never began has nothing to keep.
        end: () => close(mine, true, failure),
      });
    },
    finish() {
      const mine = session;
      if (!mine) return Promise.resolve(false);
      // Not hearing yet: there are no words to wait for.
      if (!mine.spoken) {
        cancel();
        return Promise.resolve(false);
      }
      const done = new Promise<boolean>((tell) => mine.waiting.push(tell));
      const take = store.getState().take;
      if (take && take.phase !== "finishing") {
        store.setState({ take: { ...take, phase: "finishing" } });
        mine.giveUp = setTimeout(() => {
          close(mine, true);
          recognizer.abort();
        }, LAST_WORDS_MS);
        recognizer.stop();
      }
      return done;
    },
    cancel,
    dismissNotice: () => store.setState({ notice: null }),
    level: () => level,
  };
}

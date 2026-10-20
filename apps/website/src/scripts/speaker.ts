import { schedule, volume, type Sound } from "./sounds";

/*
 * Plays the interface sounds through one AudioContext, made on the first gesture that asks for
 * a sound (browsers start audio only then) and closed when sound is turned off, so nothing is
 * held while it is off. Sound is on until the visitor turns it off, as on bencho.dev, and the
 * choice is kept in localStorage.
 */

const key = "openorc-site-sound";
/** How far, in cents, a play may stray from the sound's pitch, so repeats never sound stamped out. */
const detune = 30;

let audio: { context: AudioContext; master: GainNode } | null = null;
let wanted: boolean | undefined;
const listeners = new Set<() => void>();

const nothing = () => {};

function read() {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

/** Whether the visitor wants interface sounds. */
export function isSoundOn() {
  return (wanted ??= read());
}

export function setSoundOn(on: boolean) {
  wanted = on;
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {}
  if (!on && audio) {
    void audio.context.close();
    audio = null;
  }
  for (const listener of listeners) listener();
}

export function onSoundChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The audio context, woken if a gesture lets it run, or null when audio cannot play yet. */
function wake() {
  const allowed = navigator.userActivation.isActive;
  if (!audio) {
    if (!allowed) return null;
    const context = new AudioContext();
    const master = new GainNode(context, { gain: volume });
    master.connect(context.destination);
    audio = { context, master };
  }
  if (audio.context.state === "running") return audio;
  if (!allowed) return null;
  void audio.context.resume();
  return audio;
}

/**
 * Plays a sound now, or `after` ms from now, when sound is on. Returns a function that calls it
 * off if it has not started yet, for a sound that should land with a change still on its way.
 */
export function play(sound: Sound, after = 0): () => void {
  if (!isSoundOn()) return nothing;
  const awake = wake();
  if (!awake) return nothing;
  const { context, master } = awake;
  const start = context.currentTime + after / 1000;
  const cents = (Math.random() * 2 - 1) * detune;
  const gain = 1 + (Math.random() * 2 - 1) * 0.1;
  const sources = schedule(context, master, sound, start, cents, gain);
  return () => {
    if (context.currentTime < start) for (const source of sources) source.stop();
  };
}

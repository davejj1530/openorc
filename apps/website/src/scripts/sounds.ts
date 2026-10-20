/*
 * The site's interface sounds, synthesized with the Web Audio API so it ships no audio files.
 * A sound is a few voices: a tone that may glide in pitch, or a breath of noise cut to a band,
 * each rising in a millisecond or two and falling away exponentially. They sit low, in the key
 * of A, so the ones that carry a pitch agree with each other.
 */

/** One part of a sound. Times are in ms from the start of the sound, pitches in Hz. */
interface Voice {
  source: "sine" | "triangle" | "noise";
  /** A tone's pitch, or the middle of the band a noise is cut to. */
  hz: number;
  /** Where the pitch glides to over the first `glide` ms. */
  to?: number;
  glide?: number;
  /** Peak level from 0 to 1, before the master volume. */
  level: number;
  attack: number;
  /** How long it takes to fall silent after its peak. */
  decay: number;
  at?: number;
  /** Where a tone starts to soften. */
  cutoff?: number;
  /** How narrow a noise's band is. */
  q?: number;
}

export const sounds = {
  /** A press going down: a low, felt thump with the touch of a fingertip on top. */
  tap: [
    { source: "sine", hz: 220, to: 165, glide: 40, level: 0.9, attack: 2, decay: 90, cutoff: 900 },
    { source: "noise", hz: 1500, q: 1.2, level: 0.35, attack: 1, decay: 16 },
  ],
  /** A press letting go, or a click: a short, dry tick. */
  click: [
    { source: "triangle", hz: 880, to: 587, glide: 18, level: 0.5, attack: 1, decay: 45, cutoff: 2400 },
    { source: "noise", hz: 3600, q: 0.9, level: 0.3, attack: 0.5, decay: 9 },
  ],
  /** A switch turning on: two ticks a fifth apart, rising. */
  on: [
    { source: "noise", hz: 2800, q: 1, level: 0.2, attack: 0.5, decay: 8 },
    { source: "sine", hz: 440, level: 0.55, attack: 1.5, decay: 60, cutoff: 2000 },
    { source: "sine", hz: 659.25, level: 0.5, attack: 1.5, decay: 90, cutoff: 2400, at: 55 },
  ],
  /** A switch turning off: the same ticks falling, a little duller. */
  off: [
    { source: "noise", hz: 2200, q: 1, level: 0.18, attack: 0.5, decay: 8 },
    { source: "sine", hz: 659.25, level: 0.45, attack: 1.5, decay: 55, cutoff: 1500 },
    { source: "sine", hz: 440, level: 0.45, attack: 1.5, decay: 80, cutoff: 1300, at: 55 },
  ],
  /** A small pop: a bubble's quick sweep up. */
  pop: [{ source: "sine", hz: 330, to: 880, glide: 26, level: 0.55, attack: 2, decay: 50 }],
  /** Something finished: two bells a fifth apart, each with a faint octave above. */
  done: [
    { source: "sine", hz: 880, level: 0.4, attack: 2, decay: 170 },
    { source: "sine", hz: 1760, level: 0.06, attack: 2, decay: 90 },
    { source: "sine", hz: 1318.51, level: 0.42, attack: 2, decay: 280, at: 75 },
    { source: "sine", hz: 2637.02, level: 0.06, attack: 2, decay: 130, at: 75 },
  ],
} satisfies Record<string, Voice[]>;

export type Sound = keyof typeof sounds;

export const isSound = (name: string): name is Sound => Object.hasOwn(sounds, name);

/** How loud every sound plays: low, so they stay under the page. Peaks land around -25 dBFS. */
export const volume = 0.1;

/** One noise buffer per context, made the first time a sound needs it. */
const noises = new WeakMap<BaseAudioContext, AudioBuffer>();

function noise(context: BaseAudioContext) {
  let buffer = noises.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate / 4, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    noises.set(context, buffer);
  }
  return buffer;
}

/** Starts a voice's source at `start` and returns it with the node its sound comes out of. */
function startVoice(context: BaseAudioContext, voice: Voice, start: number, ratio: number): { source: AudioScheduledSourceNode; output: AudioNode } {
  if (voice.source === "noise") {
    const source = new AudioBufferSourceNode(context, { buffer: noise(context), loop: true });
    const band = new BiquadFilterNode(context, { type: "bandpass", frequency: voice.hz * ratio, Q: voice.q ?? 1 });
    source.start(start, Math.random() * 0.2);
    return { source, output: source.connect(band) };
  }
  const source = new OscillatorNode(context, { type: voice.source });
  source.frequency.setValueAtTime(voice.hz * ratio, start);
  if (voice.to) source.frequency.exponentialRampToValueAtTime(voice.to * ratio, start + (voice.glide ?? voice.decay) / 1000);
  source.start(start);
  if (!voice.cutoff) return { source, output: source };
  return { source, output: source.connect(new BiquadFilterNode(context, { type: "lowpass", frequency: voice.cutoff, Q: 0.5 })) };
}

/**
 * Schedules a sound into `output` at `when`, in the context's seconds, pitched `cents` away and
 * at `gain` times its level. Returns its sources, so it can be called off before it starts.
 */
export function schedule(context: BaseAudioContext, output: AudioNode, sound: Sound, when: number, cents = 0, gain = 1) {
  const ratio = 2 ** (cents / 1200);
  return sounds[sound].map((voice: Voice) => {
    const start = when + (voice.at ?? 0) / 1000;
    const peak = start + voice.attack / 1000;
    const end = peak + voice.decay / 1000;
    const { source, output: voiced } = startVoice(context, voice, start, ratio);
    const envelope = new GainNode(context, { gain: 0 });
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(voice.level * gain, peak);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    voiced.connect(envelope).connect(output);
    source.stop(end + 0.01);
    return source;
  });
}

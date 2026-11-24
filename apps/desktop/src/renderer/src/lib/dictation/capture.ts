// A file of its own, never inlined: the page's content policy loads scripts only from the app's own files.
import workletUrl from "./pcm-worklet.js?url&no-inline";

export interface Capture {
  stop(): void;
  /** How loud the microphone is at this moment, from 0 to 1. */
  level(): number;
}

/**
 * Records the chosen microphone, or the system's when none is chosen or the chosen one is gone, and hands over mono
 * samples in blocks at the rate asked for, which the page's audio graph converts the microphone's own rate to. Echo cancelling and noise suppression stay off: on macOS they switch the whole
 * computer to its call mode, which lowers everything else that is playing.
 */
export async function captureMicrophone(deviceId: string | null, sampleRate: number, onBlock: (pcm: Float32Array) => void): Promise<Capture> {
  const sound = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: deviceId ? { ...sound, deviceId: { exact: deviceId } } : sound })
    .catch((error: unknown) => (deviceId && error instanceof DOMException && error.name === "OverconstrainedError" ? navigator.mediaDevices.getUserMedia({ audio: sound }) : Promise.reject(error)));
  const context = new AudioContext({ sampleRate });
  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  try {
    await context.audioWorklet.addModule(workletUrl);
    const blocks = new AudioWorkletNode(context, "pcm-capture", { numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
    blocks.port.onmessage = (event: MessageEvent<Float32Array>) => onBlock(event.data);
    // The last thirtieth of a second, read whenever a frame is drawn, so what shows the voice moves as smoothly as the screen does.
    const heard = new AnalyserNode(context, { fftSize: 512, smoothingTimeConstant: 0 });
    const latest = new Float32Array(heard.fftSize);
    const source = context.createMediaStreamSource(stream);
    source.connect(blocks);
    source.connect(heard);
    const level = () => {
      heard.getFloatTimeDomainData(latest);
      return loudness(latest);
    };
    return { stop, level };
  } catch (error) {
    stop();
    throw error;
  }
}

/** The hum of a quiet room, which reads as silence. */
const ROOM = 0.003;

/**
 * How loud samples are, from 0 to 1. The scale follows the ear more than the meter: quiet speech already shows, and
 * ordinary speech fills most of it without a raised voice pinning it at the top.
 */
function loudness(pcm: Float32Array): number {
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.min(1, Math.sqrt(Math.max(0, Math.sqrt(sum / pcm.length) - ROOM) * 4));
}

// A file of its own, never inlined: the page's content policy loads scripts only from the app's own files.
import workletUrl from "./pcm-worklet.js?url&no-inline";

/** The rate speech models hear at. The page's audio graph converts the microphone's own rate to it. */
const SAMPLE_RATE = 16_000;

export interface Capture {
  stop(): void;
}

/**
 * Records the chosen microphone, or the system's when none is chosen or the chosen one is gone, and hands over mono
 * samples at 16 kHz in blocks. Echo cancelling and noise suppression stay off: on macOS they switch the whole
 * computer to its call mode, which lowers everything else that is playing.
 */
export async function captureMicrophone(deviceId: string | null, onBlock: (pcm: Float32Array) => void): Promise<Capture> {
  const sound = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: deviceId ? { ...sound, deviceId: { exact: deviceId } } : sound })
    .catch((error: unknown) => (deviceId && error instanceof DOMException && error.name === "OverconstrainedError" ? navigator.mediaDevices.getUserMedia({ audio: sound }) : Promise.reject(error)));
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  try {
    await context.audioWorklet.addModule(workletUrl);
    const blocks = new AudioWorkletNode(context, "pcm-capture", { numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
    blocks.port.onmessage = (event: MessageEvent<Float32Array>) => onBlock(event.data);
    context.createMediaStreamSource(stream).connect(blocks);
    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** How loud a block is, from 0 to 1, on a scale where ordinary speech fills most of it. */
export function loudness(pcm: Float32Array): number {
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / pcm.length) * 8);
}

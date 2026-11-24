import type { SpeechRequest } from "../shared/dictation";
import { speechEngine } from "./engine";

/**
 * Utility-process entry for dictation. Main forks it for the first recording and ends it after a quiet while, which
 * gives the model's memory back. The speech library is native code that drives the graphics card; in a process of its
 * own, a fault there ends a recording and nothing else.
 */
const engine = speechEngine(
  async (file) => {
    const { TranscribeModel } = await import("transcribe-cpp");
    return TranscribeModel.load(file);
  },
  (event) => process.parentPort.postMessage(event),
);

process.parentPort.on("message", (event) => engine.receive(event.data as SpeechRequest));

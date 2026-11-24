import type { DictationEvent, SpeechRequest } from "../shared/dictation";

/** What a recording uses of a loaded model: one stream that takes samples as they arrive and says what it hears. */
export interface SpeechStream {
  feed(pcm: Float32Array): Promise<{ committedChanged: boolean; tentativeChanged: boolean }>;
  finalize(): Promise<unknown>;
  readonly text: { full: string };
  readonly snapshot: { text: string };
  reset(): void;
}

export interface LoadedSpeechModel {
  createSession(): { stream(): Promise<SpeechStream>; dispose(): void };
  dispose(): void;
}

interface Take {
  id: string;
  file: string;
  heard: Float32Array[];
  end: "finish" | "cancel" | null;
  /** Wakes the recording when it has caught up and waits for more. */
  wake: () => void;
}

function joined(blocks: Float32Array[]): Float32Array {
  if (blocks.length === 1) return blocks[0]!;
  const all = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    all.set(block, at);
    at += block.length;
  }
  return all;
}

const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "The speech model stopped.");

/**
 * Dictation's recordings, one at a time. Samples wait while the model loads or works, and everything waiting goes to
 * it in one piece, so a slow start is caught up rather than dropped. The model stays loaded for the next recording;
 * asking for another file replaces it.
 */
export function speechEngine(load: (file: string) => Promise<LoadedSpeechModel>, post: (event: DictationEvent) => void) {
  let loaded: { file: string; model: Promise<LoadedSpeechModel> } | null = null;
  let take: Take | null = null;
  // A model holds one stream at a time, so a recording starts once the one before it has let go.
  let running: Promise<void> = Promise.resolve();

  const modelAt = (file: string) => {
    if (loaded?.file === file) return loaded.model;
    const before = loaded?.model;
    const model = (async () => {
      (await before?.catch(() => null))?.dispose();
      return load(file);
    })();
    loaded = { file, model };
    // A load that failed is forgotten, so the next recording tries again.
    model.catch(() => {
      if (loaded?.model === model) loaded = null;
    });
    return model;
  };

  async function run(current: Take): Promise<void> {
    const session = (await modelAt(current.file)).createSession();
    try {
      const stream = await session.stream();
      try {
        while (current.end !== "cancel") {
          const pcm = joined(current.heard.splice(0));
          if (pcm.length) {
            const update = await stream.feed(pcm);
            if (!current.end && (update.committedChanged || update.tentativeChanged)) post({ type: "words", id: current.id, words: stream.text.full.trim() });
          } else if (current.end === "finish") {
            await stream.finalize();
            post({ type: "done", id: current.id, words: stream.snapshot.text.trim() });
            return;
          } else await new Promise<void>((resolve) => (current.wake = resolve));
        }
      } finally {
        stream.reset();
      }
    } finally {
      session.dispose();
    }
  }

  return {
    receive(request: SpeechRequest): void {
      if (request.type === "start") {
        if (take) {
          take.end = "cancel";
          take.wake();
        }
        const current: Take = { id: request.id, file: request.file, heard: [], end: null, wake: () => undefined };
        take = current;
        running = running
          .then(() => run(current))
          .catch((error: unknown) => {
            if (current.end !== "cancel") post({ type: "failed", id: current.id, reason: reasonOf(error) });
          })
          .finally(() => {
            if (take === current) take = null;
          });
        return;
      }
      if (take?.id !== request.id) return;
      if (request.type === "audio") take.heard.push(request.pcm);
      else take.end = request.type;
      take.wake();
    },
  };
}

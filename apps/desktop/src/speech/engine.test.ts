import { describe, expect, it } from "vitest";
import type { DictationEvent } from "../shared/dictation";
import { speechEngine, type LoadedSpeechModel } from "./engine";

/** A model that hears each sample as a word, so a test can read what reached it and in what pieces. */
function standIn() {
  const fed: number[] = [];
  let loads = 0;
  let open = 0;
  const load = async (): Promise<LoadedSpeechModel> => {
    loads += 1;
    return {
      dispose: () => undefined,
      createSession: () => ({
        dispose: () => undefined,
        stream: async () => {
          open += 1;
          const heard: number[] = [];
          return {
            feed: async (pcm) => {
              fed.push(pcm.length);
              heard.push(...pcm);
              return { committedChanged: true, tentativeChanged: false };
            },
            finalize: async () => undefined,
            get text() {
              return { full: heard.join(" ") };
            },
            get snapshot() {
              return { text: `${heard.join(" ")}.` };
            },
            reset: () => void (open -= 1),
          };
        },
      }),
    };
  };
  return { load, fed, loads: () => loads, open: () => open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const pcm = (...samples: number[]) => new Float32Array(samples);

describe("speechEngine", () => {
  it("hears what arrived while the model loaded in one piece, then word by word, and ends with the final text", async () => {
    const model = standIn();
    const events: DictationEvent[] = [];
    const engine = speechEngine(model.load, (event) => events.push(event));
    engine.receive({ type: "start", id: "a", file: "model.gguf" });
    engine.receive({ type: "audio", id: "a", pcm: pcm(1, 2) });
    engine.receive({ type: "audio", id: "a", pcm: pcm(3) });
    await settle();
    engine.receive({ type: "audio", id: "a", pcm: pcm(4) });
    await settle();
    engine.receive({ type: "finish", id: "a" });
    await settle();
    expect(model.fed).toEqual([3, 1]);
    expect(events).toEqual([
      { type: "words", id: "a", words: "1 2 3" },
      { type: "words", id: "a", words: "1 2 3 4" },
      { type: "done", id: "a", words: "1 2 3 4." },
    ]);
    expect(model.open()).toBe(0);
  });

  it("says nothing more of a cancelled recording, and keeps the model for the next", async () => {
    const model = standIn();
    const events: DictationEvent[] = [];
    const engine = speechEngine(model.load, (event) => events.push(event));
    engine.receive({ type: "start", id: "a", file: "model.gguf" });
    engine.receive({ type: "audio", id: "a", pcm: pcm(1) });
    engine.receive({ type: "cancel", id: "a" });
    engine.receive({ type: "start", id: "b", file: "model.gguf" });
    engine.receive({ type: "audio", id: "b", pcm: pcm(7) });
    engine.receive({ type: "finish", id: "b" });
    await settle();
    expect(events).toEqual([{ type: "done", id: "b", words: "7." }]);
    expect(model.loads()).toBe(1);
  });

  it("reports a model that will not load, and tries again for the next recording", async () => {
    let attempts = 0;
    const model = standIn();
    const events: DictationEvent[] = [];
    const engine = speechEngine(
      () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("The file is not a model.")) : model.load();
      },
      (event) => events.push(event),
    );
    engine.receive({ type: "start", id: "a", file: "model.gguf" });
    await settle();
    engine.receive({ type: "start", id: "b", file: "model.gguf" });
    engine.receive({ type: "finish", id: "b" });
    await settle();
    expect(events).toEqual([
      { type: "failed", id: "a", reason: "The file is not a model." },
      { type: "done", id: "b", words: "." },
    ]);
  });
});

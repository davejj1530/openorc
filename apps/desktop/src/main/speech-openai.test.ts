import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationEvent } from "../shared/dictation";
import { OpenAiSpeech, type LiveSocket } from "./speech-openai";

/** A stand-in for the service's socket: it keeps what was sent, and a test speaks the service's part through `say`. */
function standIn() {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const dialled: { url: string; headers: Record<string, string> }[] = [];
  let closed = false;
  const socket: LiveSocket = { send: (data) => void sent.push(JSON.parse(data)), close: () => void (closed = true), onopen: null, onmessage: null, onclose: null, onerror: null };
  const events: DictationEvent[] = [];
  const speech = new OpenAiSpeech(
    async () => "sk-example",
    (url, headers) => {
      dialled.push({ url, headers });
      return socket;
    },
    (event) => events.push(event),
  );
  const say = (event: object) => socket.onmessage?.({ data: JSON.stringify(event) });
  return { speech, socket, sent, dialled, events, say, closed: () => closed, types: () => sent.map((each) => each.type) };
}

/** A tenth of a second at 24 kHz, loud as speech or silent. */
const block = (loud: boolean) => new Float32Array(2400).fill(loud ? 0.2 : 0);
const transcription = "conversation.item.input_audio_transcription";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("OpenAiSpeech", () => {
  it("opens a transcription session on the person's key and sends what was heard meanwhile, as 16-bit samples", async () => {
    const live = standIn();
    live.speech.start("a");
    await vi.advanceTimersByTimeAsync(0);
    live.speech.audio("a", new Float32Array([0, 1, -1]));
    live.socket.onopen?.();
    expect(live.dialled).toEqual([{ url: "wss://api.openai.com/v1/realtime?intent=transcription", headers: { Authorization: "Bearer sk-example" } }]);
    expect(live.sent[0]).toEqual({
      type: "session.update",
      session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: null } } },
    });
    expect(live.sent[1]).toEqual({ type: "input_audio_buffer.append", audio: Buffer.from(new Int16Array([0, 32767, -32767]).buffer).toString("base64") });
  });

  it("closes a turn at each pause after speech, reports words as they come in the order spoken, and ends with every turn's final words", async () => {
    const live = standIn();
    live.speech.start("a");
    await vi.advanceTimersByTimeAsync(0);
    live.socket.onopen?.();
    live.speech.audio("a", block(true));
    for (let quiet = 0; quiet < 7; quiet += 1) live.speech.audio("a", block(false));
    expect(live.types().filter((type) => type === "input_audio_buffer.commit")).toHaveLength(1);
    // Silence alone closes no turn.
    for (let quiet = 0; quiet < 20; quiet += 1) live.speech.audio("a", block(false));
    expect(live.types().filter((type) => type === "input_audio_buffer.commit")).toHaveLength(1);
    live.say({ type: "input_audio_buffer.committed", item_id: "one" });
    live.say({ type: `${transcription}.delta`, item_id: "one", delta: "Open the" });
    live.speech.audio("a", block(true));
    live.speech.finish("a");
    expect(live.types().filter((type) => type === "input_audio_buffer.commit")).toHaveLength(2);
    live.say({ type: "input_audio_buffer.committed", item_id: "two" });
    // The second turn's words can settle before the first's.
    live.say({ type: `${transcription}.completed`, item_id: "two", transcript: "and rename it." });
    expect(live.events.at(-1)).toEqual({ type: "words", id: "a", words: "Open the" });
    live.say({ type: `${transcription}.completed`, item_id: "one", transcript: "Open the file" });
    expect(live.events.at(-1)).toEqual({ type: "done", id: "a", words: "Open the file and rename it." });
    expect(live.closed()).toBe(true);
  });

  it("ends at once when nothing was said", async () => {
    const live = standIn();
    live.speech.start("a");
    await vi.advanceTimersByTimeAsync(0);
    live.socket.onopen?.();
    live.speech.audio("a", block(false));
    live.speech.finish("a");
    expect(live.events).toEqual([{ type: "done", id: "a", words: "" }]);
  });

  it("says why the service refused, and when it does not answer", async () => {
    const refused = standIn();
    refused.speech.start("a");
    await vi.advanceTimersByTimeAsync(0);
    refused.socket.onopen?.();
    refused.say({ type: "error", error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-ex****ple." } });
    expect(refused.events).toEqual([{ type: "failed", id: "a", reason: "OpenAI did not accept the API key." }]);

    const overloaded = standIn();
    overloaded.speech.start("d");
    await vi.advanceTimersByTimeAsync(0);
    overloaded.socket.onopen?.();
    overloaded.say({ type: "error", error: { code: "server_error", message: "The server had an error." } });
    expect(overloaded.events).toEqual([{ type: "failed", id: "d", reason: "The server had an error." }]);

    const unreachable = standIn();
    unreachable.speech.start("b");
    await vi.advanceTimersByTimeAsync(0);
    unreachable.socket.onerror?.();
    expect(unreachable.events).toEqual([{ type: "failed", id: "b", reason: "Couldn’t reach OpenAI. Check your API key and your connection." }]);

    const silent = standIn();
    silent.speech.start("c");
    await vi.advanceTimersByTimeAsync(0);
    silent.socket.onopen?.();
    silent.speech.audio("c", block(true));
    silent.speech.finish("c");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(silent.events).toEqual([{ type: "failed", id: "c", reason: "OpenAI took too long to answer." }]);
  });

  it("sends nothing more of a cancelled recording", async () => {
    const live = standIn();
    live.speech.start("a");
    await vi.advanceTimersByTimeAsync(0);
    live.socket.onopen?.();
    live.speech.cancel("a");
    live.say({ type: `${transcription}.delta`, item_id: "one", delta: "late" });
    expect(live.events).toEqual([]);
    expect(live.closed()).toBe(true);
  });
});

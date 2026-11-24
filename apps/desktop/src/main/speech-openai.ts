import type { DictationEvent } from "../shared/dictation";
import type { Transcriber } from "./speech-host";

/** The socket OpenAI is spoken to over. Node's WebSocket fits, and a test hands in its own. */
export interface LiveSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type ConnectLive = (url: string, headers: Record<string, string>) => LiveSocket;

const ENDPOINT = "wss://api.openai.com/v1/realtime?intent=transcription";
const MODEL = "gpt-live-transcribe";
/** The one rate the service takes, as 16-bit samples. */
const RATE = 24_000;
/** How loud a block is before it counts as speech, as the root mean square of its samples. */
const SPEECH = 0.01;
/** A pause this long after speech ends a turn. The service has no ear for pauses of its own, and settles a turn's words when told it is over. */
const PAUSE_MS = 700;
/** How long the last words may take once the recording is finished. */
const LAST_WORDS_MS = 15_000;

interface Take {
  id: string;
  socket: LiveSocket;
  open: boolean;
  /** Audio heard before the socket opened, sent once it has. */
  waiting: string[];
  /** Whether speech has been heard since the last turn was closed, and how long it has been quiet since. */
  spoke: boolean;
  quietMs: number;
  /** Turns in the order they were first heard of, their words so far, and which have their final words. */
  turns: string[];
  words: Map<string, string>;
  settled: Set<string>;
  /** Turns closed whose item the service has not named yet. */
  closing: number;
  finishing: ReturnType<typeof setTimeout> | null;
}

/** One of the service's events, as far as a recording reads it. */
interface LiveEvent {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { code?: string; message?: string };
}

/** What each event about a turn does to it. Any other event, named for a turn or not, is none of a recording's business. */
const TURN_EVENTS: Record<string, (take: Take, turn: string, event: LiveEvent) => void> = {
  "input_audio_buffer.committed": (take) => void (take.closing -= 1),
  "conversation.item.input_audio_transcription.delta": (take, turn, event) => void take.words.set(turn, (take.words.get(turn) ?? "") + (event.delta ?? "")),
  "conversation.item.input_audio_transcription.completed": (take, turn, event) => {
    take.words.set(turn, event.transcript ?? take.words.get(turn) ?? "");
    take.settled.add(turn);
  },
  "conversation.item.input_audio_transcription.failed": (take, turn) => void take.settled.add(turn),
};

/** Why the service refused, in its own words unless it is the key, which the person can do something about. */
const refusal = (error: LiveEvent["error"]) => (error?.code === "invalid_api_key" ? "OpenAI did not accept the API key." : (error?.message ?? "OpenAI refused the recording."));

function loudness(pcm: Float32Array): number {
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

function pcm16(pcm: Float32Array): string {
  const bytes = Buffer.allocUnsafe(pcm.length * 2);
  pcm.forEach((sample, index) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), index * 2));
  return bytes.toString("base64");
}

/**
 * Dictation through OpenAI's live transcription, on the person's own API key. One recording is one socket: audio is
 * sent as it is heard, and each pause closes a turn, whose words the service then settles. Words are reported as they
 * arrive, turn after turn in the order spoken, whenever the service sends them. Finishing closes the last turn and
 * waits for every turn's final words. Nothing is kept here: when the recording ends the socket is closed.
 */
export class OpenAiSpeech implements Transcriber {
  private take: Take | null = null;

  constructor(
    private readonly key: () => Promise<string | null>,
    private readonly connect: ConnectLive,
    private readonly report: (event: DictationEvent) => void,
  ) {}

  start(id: string): void {
    this.close();
    void this.key().then(
      (key) => (key ? this.begin(id, key) : this.report({ type: "failed", id, reason: "Add your OpenAI API key in Settings to dictate with OpenAI." })),
      () => this.report({ type: "failed", id, reason: "The saved OpenAI key could not be read." }),
    );
  }

  audio(id: string, pcm: Float32Array): void {
    const take = this.take;
    if (take?.id !== id || take.finishing) return;
    const audio = JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16(pcm) });
    if (take.open) take.socket.send(audio);
    else take.waiting.push(audio);
    if (loudness(pcm) >= SPEECH) {
      take.spoke = true;
      take.quietMs = 0;
      return;
    }
    take.quietMs += (pcm.length / RATE) * 1000;
    if (take.spoke && take.quietMs >= PAUSE_MS) this.closeTurn(take);
  }

  finish(id: string): void {
    const take = this.take;
    if (take?.id !== id || take.finishing) return;
    if (take.spoke) this.closeTurn(take);
    take.finishing = setTimeout(() => this.fail(take, "OpenAI took too long to answer."), LAST_WORDS_MS);
    this.settle(take);
  }

  cancel(id: string): void {
    if (this.take?.id === id) this.close();
  }

  close(): void {
    const take = this.take;
    if (!take) return;
    this.take = null;
    if (take.finishing) clearTimeout(take.finishing);
    take.socket.onclose = take.socket.onerror = take.socket.onmessage = null;
    take.socket.close();
  }

  private begin(id: string, key: string): void {
    const socket = this.connect(ENDPOINT, { Authorization: `Bearer ${key}` });
    const take: Take = { id, socket, open: false, waiting: [], spoke: false, quietMs: 0, turns: [], words: new Map(), settled: new Set(), closing: 0, finishing: null };
    this.take = take;
    socket.onopen = () => {
      take.open = true;
      const transcription = { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: RATE }, transcription: { model: MODEL }, turn_detection: null } } };
      socket.send(JSON.stringify({ type: "session.update", session: transcription }));
      for (const audio of take.waiting.splice(0)) socket.send(audio);
    };
    socket.onmessage = (event) => this.heard(take, event.data);
    socket.onerror = () => this.fail(take, take.open ? "The connection to OpenAI broke." : "Couldn’t reach OpenAI. Check your API key and your connection.");
    socket.onclose = () => this.fail(take, "OpenAI ended the connection.");
  }

  private closeTurn(take: Take): void {
    take.spoke = false;
    take.closing += 1;
    const commit = JSON.stringify({ type: "input_audio_buffer.commit" });
    if (take.open) take.socket.send(commit);
    else take.waiting.push(commit);
  }

  private heard(take: Take, data: unknown): void {
    if (this.take !== take || typeof data !== "string") return;
    const event = JSON.parse(data) as LiveEvent;
    if (event.type === "error") return this.fail(take, refusal(event.error));
    const turn = event.item_id;
    const apply = TURN_EVENTS[event.type ?? ""];
    if (!turn || !apply) return;
    if (!take.turns.includes(turn)) take.turns.push(turn);
    apply(take, turn, event);
    if (!take.finishing) this.report({ type: "words", id: take.id, words: this.said(take) });
    this.settle(take);
  }

  /** The words of every turn, in the order the turns were spoken. */
  private said(take: Take): string {
    return take.turns
      .map((turn) => take.words.get(turn)?.trim())
      .filter(Boolean)
      .join(" ");
  }

  /** Ends a finished recording once every turn it closed has its final words. */
  private settle(take: Take): void {
    if (!take.finishing || take.closing > 0 || take.turns.some((turn) => !take.settled.has(turn))) return;
    const words = this.said(take);
    this.close();
    this.report({ type: "done", id: take.id, words });
  }

  private fail(take: Take, reason: string): void {
    if (this.take !== take) return;
    this.close();
    this.report({ type: "failed", id: take.id, reason });
  }
}

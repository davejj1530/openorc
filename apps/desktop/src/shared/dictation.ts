/** A speech model the app downloads once and runs on this computer. */
export interface SpeechModel {
  id: string;
  name: string;
  /** What it understands, in a word or two. */
  languages: string;
  /** Who made it and the license it is shared under. */
  credit: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

const hosted = (repository: string, revision: string, file: string) => `https://huggingface.co/${repository}/resolve/${revision}/${file}`;

/** Each model is pinned to one revision, so the bytes and their hash never change under an installed app. */
export const SPEECH_MODELS: readonly SpeechModel[] = [
  {
    id: "parakeet-unified-en",
    name: "Parakeet",
    languages: "English",
    credit: "NVIDIA, CC BY 4.0",
    file: "parakeet-unified-en-0.6b-Q8_0.gguf",
    url: hosted("handy-computer/parakeet-unified-en-0.6b-gguf", "7e948f21b7bdbac698d3318db9d350f1096f3b6c", "parakeet-unified-en-0.6b-Q8_0.gguf"),
    bytes: 731_357_568,
    sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
  },
];

export const DEFAULT_SPEECH_MODEL = SPEECH_MODELS[0]!;

export const speechModel = (id: string): SpeechModel | undefined => SPEECH_MODELS.find((model) => model.id === id);

/** Where a model is: not on this computer, on its way, here, or stopped by a failed download. */
export type SpeechModelState = { phase: "missing" } | { phase: "downloading"; received: number } | { phase: "ready" } | { phase: "failed"; reason: string };

/** What a recording reports: the words heard so far, the words it ended with, or why it stopped. */
export type DictationEvent = { type: "words"; id: string; words: string } | { type: "done"; id: string; words: string } | { type: "failed"; id: string; reason: string };

/** What the window asks of the speech process: start a recording on a model file, hear more of it, end it. */
export type SpeechRequest = { type: "start"; id: string; file: string } | { type: "audio"; id: string; pcm: Float32Array } | { type: "finish"; id: string } | { type: "cancel"; id: string };

/** Whether the operating system lets the app hear the microphone. */
export type MicrophoneAccess = "granted" | "denied";

/**
 * Dictation, as the window reaches it. Main keeps the model files and the process that runs them; the window records
 * and sends what it hears as 16 kHz mono samples.
 */
export interface DictationApi {
  models(): Promise<Record<string, SpeechModelState>>;
  download(model: string): Promise<void>;
  cancelDownload(model: string): Promise<void>;
  remove(model: string): Promise<void>;
  onModel(callback: (model: string, state: SpeechModelState) => void): () => void;
  /** Asks the operating system for the microphone, the first time. */
  microphone(): Promise<MicrophoneAccess>;
  openMicrophoneSettings(): void;
  start(id: string, model: string): Promise<void>;
  audio(id: string, pcm: Float32Array): void;
  finish(id: string): void;
  cancel(id: string): void;
  onEvent(callback: (event: DictationEvent) => void): () => void;
}

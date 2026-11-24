import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, shell, systemPreferences, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { DEFAULT_SPEECH_MODEL, speechModel, type DictationEngine, type DictationEvent, type DictationSettings, type MicrophoneAccess, type SpeechModel } from "../shared/dictation";
import { loadProtectedSecret, saveProtectedSecret } from "./protected-secrets";
import { SpeechHost, type Transcriber } from "./speech-host";
import { SpeechModels } from "./speech-models";
import { OpenAiSpeech, type ConnectLive, type LiveSocket } from "./speech-openai";

const LIBRARY: Partial<Record<NodeJS.Platform, string>> = { darwin: "libtranscribe.dylib", win32: "transcribe.dll", linux: "libtranscribe.so" };

/**
 * Where the speech library is in a package. The operating system loads it by path, and cannot from inside the app's
 * archive, so the package keeps the one build for its platform unpacked beside it.
 */
function packagedLibrary(): string {
  const builds = join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@transcribe-cpp");
  return join(builds, readdirSync(builds)[0]!, LIBRARY[process.platform]!);
}

const forkSpeech = (here: string) =>
  utilityProcess.fork(join(here, "speech.mjs"), [], {
    serviceName: "openorc-speech",
    env: app.isPackaged ? { ...process.env, TRANSCRIBE_LIBRARY: packagedLibrary() } : process.env,
  });

/** Node's WebSocket takes headers as its second argument, which the browser's type does not say. The key rides in one, and so never reaches a window. */
const connectLive: ConnectLive = (url, headers) => new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => LiveSocket)(url, { headers });

/** Asks for the microphone where the operating system has not been asked yet; elsewhere, says what it already decided. */
async function microphoneAccess(): Promise<MicrophoneAccess> {
  if (process.platform === "linux") return "granted";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (process.platform === "darwin" && status === "not-determined") return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  return status === "denied" || status === "restricted" ? "denied" : "granted";
}

const MICROPHONE_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};

const named = (id: unknown): SpeechModel => {
  const model = typeof id === "string" ? speechModel(id) : undefined;
  if (!model) throw new Error("Unknown speech model.");
  return model;
};

type Handler = (event: IpcMainInvokeEvent, ...input: unknown[]) => unknown;

/**
 * What the person chose for dictation, kept by main: the engine, in a file of its own in the profile (the model on
 * this computer unless OpenAI was chosen), and the OpenAI key, in protected storage. `changed` hears each change.
 */
function dictationChoices(userData: string, changed: (settings: DictationSettings) => void) {
  const file = join(userData, "dictation.json");
  const keyFile = join(userData, "dictation-openai-key");
  const engine = (): DictationEngine => {
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { engine?: unknown }).engine === "openai" ? "openai" : "local";
    } catch {
      return "local";
    }
  };
  const key = () => loadProtectedSecret(keyFile);
  const read = async (): Promise<DictationSettings> => ({ engine: engine(), openaiKey: Boolean(await key()) });
  const tell = async () => {
    const now = await read();
    changed(now);
    return now;
  };
  const handlers: Record<string, Handler> = {
    "dictation:settings": read,
    "dictation:setEngine": (_event, chosen) => {
      if (chosen !== "local" && chosen !== "openai") throw new Error("Unknown dictation engine.");
      writeFileSync(file, `${JSON.stringify({ engine: chosen })}\n`);
      return tell();
    },
    "dictation:setOpenAiKey": async (_event, value) => {
      if (typeof value !== "string" || value.length > 400) throw new Error("That is not an API key.");
      if (value.trim()) await saveProtectedSecret(keyFile, value.trim(), userData);
      else await rm(keyFile, { force: true });
      return tell();
    },
  };
  return { engine, key, handlers };
}

/** The recordings in progress, each with its window and its engine. A recording answers only to the window that started it, and ends with it. */
function recordingBook() {
  const takes = new Map<string, { contents: WebContents; by: Transcriber }>();
  const watched = new WeakSet<WebContents>();
  const close = (id: string) => takes.delete(id);
  return {
    open(id: string, contents: WebContents, by: Transcriber): void {
      takes.set(id, { contents, by });
      if (watched.has(contents)) return;
      watched.add(contents);
      contents.once("destroyed", () => {
        for (const [each, take] of takes) {
          if (take.contents !== contents) continue;
          close(each);
          take.by.cancel(each);
        }
      });
    },
    /** The engine of the recording `id` names, when `contents` started it. */
    engineOf: (contents: WebContents, id: unknown) => (typeof id === "string" && takes.get(id)?.contents === contents ? takes.get(id)!.by : null),
    close,
    /** Hands an engine's event to the recording's window; anything but more words ends the recording. */
    report(event: DictationEvent): void {
      const take = takes.get(event.id);
      if (event.type !== "words") close(event.id);
      if (take && !take.contents.isDestroyed()) take.contents.send("dictation:event", event);
    },
  };
}

/**
 * Dictation for the app's windows. Main keeps the speech models, the process that runs them, the choice of engine and
 * the OpenAI key, so dictation works the same wherever the core runs. A window records and sends samples; the words go
 * back to that window only.
 */
export function installDictation(input: { userData: string; here: string; isAppOrigin: (url: string) => boolean }): () => void {
  const windows = () => BrowserWindow.getAllWindows().filter((win) => input.isAppOrigin(win.webContents.getURL()));
  const tellAll = (channel: string, ...payload: unknown[]) => {
    for (const win of windows()) win.webContents.send(channel, ...payload);
  };
  const choices = dictationChoices(input.userData, (settings) => tellAll("dictation:settings", settings));
  // Through Chromium's network stack, so a proxy this computer uses is honoured, in a session apart from the windows'.
  const models = new SpeechModels(
    join(input.userData, "speech-models"),
    (url, init) => session.fromPartition("openorc-speech-models").fetch(url, init),
    (model, state) => tellAll("dictation:model", model, state),
  );
  const book = recordingBook();
  const engines: Record<DictationEngine, Transcriber> = {
    local: new SpeechHost(
      () => forkSpeech(input.here),
      () => models.file(DEFAULT_SPEECH_MODEL),
      book.report,
    ),
    openai: new OpenAiSpeech(choices.key, connectLive, book.report),
  };
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame === event.sender.mainFrame && input.isAppOrigin(event.senderFrame?.url ?? "");
  /** The engine of this window's own recording. */
  const engineOf = (event: IpcMainEvent, id: unknown) => (trusted(event) ? book.engineOf(event.sender, id) : null);

  const handlers: Record<string, Handler> = {
    ...choices.handlers,
    "dictation:models": () => models.states(),
    "dictation:download": (_event, id) => models.download(named(id)),
    "dictation:cancelDownload": (_event, id) => models.cancel(named(id)),
    "dictation:remove": (_event, id) => models.remove(named(id)),
    "dictation:microphone": () => microphoneAccess(),
    "dictation:start": (event, id) => {
      if (typeof id !== "string" || !id) throw new Error("A recording needs an id.");
      const chosen = choices.engine();
      if (chosen === "local" && models.state(DEFAULT_SPEECH_MODEL).phase !== "ready") throw new Error("The speech model is not on this computer yet.");
      book.open(id, event.sender, engines[chosen]);
      engines[chosen].start(id);
    },
  };
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...rest: unknown[]) => {
      if (!trusted(event)) throw new Error("Only the app window can dictate.");
      return handle(event, ...rest);
    });
  }
  const events: Record<string, (event: IpcMainEvent, ...input: unknown[]) => void> = {
    "dictation:audio": (event, id, pcm) => {
      if (pcm instanceof Float32Array) engineOf(event, id)?.audio(id as string, pcm);
    },
    "dictation:finish": (event, id) => {
      engineOf(event, id)?.finish(id as string);
    },
    "dictation:cancel": (event, id) => {
      const engine = engineOf(event, id);
      if (!engine) return;
      book.close(id as string);
      engine.cancel(id as string);
    },
    "dictation:openMicrophoneSettings": (event) => {
      const url = MICROPHONE_SETTINGS[process.platform];
      if (trusted(event) && url) void shell.openExternal(url);
    },
  };
  for (const [channel, handle] of Object.entries(events)) ipcMain.on(channel, handle);

  return () => {
    for (const each of Object.values(engines)) each.close();
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const [channel, handle] of Object.entries(events)) ipcMain.off(channel, handle);
  };
}

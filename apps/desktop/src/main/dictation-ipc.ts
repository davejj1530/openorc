import { readdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, shell, systemPreferences, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { speechModel, type MicrophoneAccess, type SpeechModel } from "../shared/dictation";
import { SpeechHost } from "./speech-host";
import { SpeechModels } from "./speech-models";

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

/**
 * Dictation for the app's windows. Main keeps the speech models and the process that runs them, so dictation works the
 * same wherever the core runs. A window records and sends samples; what the model hears goes back to that window only.
 */
export function installDictation(input: { userData: string; here: string; isAppOrigin: (url: string) => boolean }): () => void {
  const windows = () => BrowserWindow.getAllWindows().filter((win) => input.isAppOrigin(win.webContents.getURL()));
  // Through Chromium's network stack, so a proxy this computer uses is honoured, in a session apart from the windows'.
  const models = new SpeechModels(
    join(input.userData, "speech-models"),
    (url, init) => session.fromPartition("openorc-speech-models").fetch(url, init),
    (model, state) => {
      for (const win of windows()) win.webContents.send("dictation:model", model, state);
    },
  );
  const listeners = new Map<string, WebContents>();
  const host = new SpeechHost(
    () => forkSpeech(input.here),
    (event) => {
      const listener = listeners.get(event.id);
      if (event.type !== "words") listeners.delete(event.id);
      if (listener && !listener.isDestroyed()) listener.send("dictation:event", event);
    },
  );
  const watched = new WeakSet<WebContents>();
  /** A window that goes away ends its recording. */
  const watch = (contents: WebContents) => {
    if (watched.has(contents)) return;
    watched.add(contents);
    contents.once("destroyed", () => {
      for (const [id, listener] of listeners) {
        if (listener !== contents) continue;
        listeners.delete(id);
        host.send({ type: "cancel", id });
      }
    });
  };
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame === event.sender.mainFrame && input.isAppOrigin(event.senderFrame?.url ?? "");
  const owns = (event: IpcMainEvent, id: unknown): id is string => trusted(event) && typeof id === "string" && listeners.get(id) === event.sender;

  const handlers: Record<string, (event: IpcMainInvokeEvent, ...input: unknown[]) => unknown> = {
    "dictation:models": () => models.states(),
    "dictation:download": (_event, id) => models.download(named(id)),
    "dictation:cancelDownload": (_event, id) => models.cancel(named(id)),
    "dictation:remove": (_event, id) => models.remove(named(id)),
    "dictation:microphone": () => microphoneAccess(),
    "dictation:start": (event, id, modelId) => {
      const model = named(modelId);
      if (typeof id !== "string" || !id) throw new Error("A recording needs an id.");
      if (models.state(model).phase !== "ready") throw new Error("The speech model is not on this computer yet.");
      listeners.set(id, event.sender);
      watch(event.sender);
      host.send({ type: "start", id, file: models.file(model) });
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
      if (owns(event, id) && pcm instanceof Float32Array) host.send({ type: "audio", id, pcm });
    },
    "dictation:finish": (event, id) => {
      if (owns(event, id)) host.send({ type: "finish", id });
    },
    "dictation:cancel": (event, id) => {
      if (!owns(event, id)) return;
      listeners.delete(id);
      host.send({ type: "cancel", id });
    },
    "dictation:openMicrophoneSettings": (event) => {
      const url = MICROPHONE_SETTINGS[process.platform];
      if (trusted(event) && url) void shell.openExternal(url);
    },
  };
  for (const [channel, handle] of Object.entries(events)) ipcMain.on(channel, handle);

  return () => {
    host.close();
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const [channel, handle] of Object.entries(events)) ipcMain.off(channel, handle);
  };
}

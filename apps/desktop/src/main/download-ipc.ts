import { dialog } from "electron";

type SaveDialog = (name: string) => Promise<string | null>;
const choose: SaveDialog = async (name) => {
  const result = await dialog.showSaveDialog({ defaultPath: name, properties: ["showOverwriteConfirmation", "createDirectory"] });
  return result.canceled ? null : (result.filePath ?? null);
};

/** The trusted core asks for one save destination. No account token or original file bytes reach main. */
export function installDownloads(child: { on(event: "message", listener: (message: unknown) => void): unknown; postMessage(message: unknown): void }, save: SaveDialog = choose): void {
  child.on("message", (message) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "download.choose") return;
    if (!("id" in message) || typeof message.id !== "number" || !Number.isSafeInteger(message.id)) return;
    const id = message.id;
    const respond = (result: { file: string | null } | { error: string }) => {
      try {
        child.postMessage({ type: "download.chosen", id, ...result });
      } catch {
        /* Core exited while the dialog was open. */
      }
    };
    if (!("name" in message) || typeof message.name !== "string" || !message.name || /[\\/\p{Cc}]/u.test(message.name)) {
      respond({ error: "Choose a filename without a folder path." });
      return;
    }
    save(message.name).then(
      (file) => respond({ file }),
      (error: unknown) => respond({ error: error instanceof Error ? error.message : "The save dialog couldn't open. Try again." }),
    );
  });
}

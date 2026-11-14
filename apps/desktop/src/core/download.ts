/** Save locations come back over main's private channel, never as renderer-supplied filesystem paths. */
export class DownloadClient {
  #nextId = 0;
  readonly #pending = new Map<number, { resolve(file: string | null): void; reject(error: Error): void }>();
  constructor(private readonly send: (message: unknown) => void) {}

  readonly choose = (name: string): Promise<string | null> => {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.send({ type: "download.choose", id, name });
      } catch {
        this.#pending.delete(id);
        reject(new Error("The save dialog couldn't open. Try again."));
      }
    });
  };

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "download.chosen") return false;
    if (!("id" in message) || typeof message.id !== "number") return true;
    const pending = this.#pending.get(message.id);
    this.#pending.delete(message.id);
    if (!pending) return true;
    if ("error" in message && typeof message.error === "string") pending.reject(new Error(message.error));
    else if ("file" in message && (message.file === null || typeof message.file === "string")) pending.resolve(message.file);
    else pending.reject(new Error("The save dialog returned an unreadable answer."));
    return true;
  }
}

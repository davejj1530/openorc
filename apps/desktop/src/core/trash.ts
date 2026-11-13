/** Long enough for Finder to move a large folder; a request with no answer by then is reported as failed, never retried. */
const ANSWER_WITHIN_MS = 60_000;

/** Asks main to move a file or folder to the system Trash, over the private utility channel. */
export class TrashClient {
  private nextId = 0;
  private readonly pending = new Map<number, (error: string | null) => void>();

  constructor(private readonly send: (message: unknown) => void) {}

  readonly move = (file: string): Promise<void> => {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (error: string | null) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error === null) resolve();
        else reject(new Error(error));
      };
      const timer = setTimeout(() => finish("The Trash did not answer. Check whether the item moved before trying again."), ANSWER_WITHIN_MS);
      this.pending.set(id, finish);
      try {
        this.send({ type: "trash", id, file });
      } catch {
        finish("The Trash is unavailable.");
      }
    });
  };

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const reply = message as { type?: unknown; id?: unknown; error?: unknown };
    if (reply.type !== "trash.result") return false;
    if (typeof reply.id === "number") this.pending.get(reply.id)?.(typeof reply.error === "string" ? reply.error : null);
    return true;
  }
}

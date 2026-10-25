/** Longer than this and the alert goes out as if nobody were at the Mac. */
const ANSWER_WITHIN_MS = 250;

/** Asks main whether someone is using the Mac, over the private utility channel. No answer reads as away. */
export class PresenceClient {
  private nextId = 0;
  private readonly pending = new Map<number, (inUse: boolean) => void>();

  constructor(private readonly send: (message: unknown) => void) {}

  readonly inUse = (): Promise<boolean> => {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const finish = (inUse: boolean) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(inUse);
      };
      const timer = setTimeout(() => finish(false), ANSWER_WITHIN_MS);
      this.pending.set(id, finish);
      try {
        this.send({ type: "presence", id });
      } catch {
        finish(false);
      }
    });
  };

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const reply = message as { type?: unknown; id?: unknown; inUse?: unknown };
    if (reply.type !== "presence.result") return false;
    if (typeof reply.id === "number") this.pending.get(reply.id)?.(reply.inUse === true);
    return true;
  }
}

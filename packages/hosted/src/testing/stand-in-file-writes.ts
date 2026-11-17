import { createHash } from "node:crypto";

type Reply = { status: number; body: unknown };
type Write = { id: string; path: string; text: string | null; expected: { kind: "version"; version: string } | { kind: "absent" } };
type Outcome = { kind: "saved"; version: string | null } | { kind: "conflict"; current: { version: string; text: string | null } | null } | { kind: "refused"; message: string };

const versionOf = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The server's writes of a cloud thread's files (its file-writes.ts), behind the `fileWrite` capability, with the
 * machine's files as a map a test sets: a write lands while the file is as the writer read it, and conflicts otherwise.
 */
export class StandInFileWrites {
  /** The machine's checkout, by thread then path. */
  readonly files = new Map<string, Map<string, string>>();
  /** Every write asked, with who asked it. */
  readonly asked: (Write & { threadId: string; who: string })[] = [];
  /** What the host answers instead of making a write, as when another person's turn is running. */
  refusal: string | null = null;

  constructor(private readonly deps: { available: () => boolean }) {}

  route(request: { method: string; path: string }, who: string, body: unknown): Reply | null {
    const match = /^\/hosted\/threads\/([^/]+)\/files$/.exec(request.path);
    if (request.method !== "PUT" || !match) return null;
    if (!this.deps.available()) return { status: 503, body: { message: "Editing this cloud workspace's files isn't available yet." } };
    const threadId = decodeURIComponent(match[1]!);
    const write = body as Write;
    this.asked.push({ ...write, threadId, who });
    return { status: 200, body: this.make(threadId, write) };
  }

  private make(threadId: string, write: Write): Outcome {
    if (this.refusal) return { kind: "refused", message: this.refusal };
    const checkout = this.files.get(threadId) ?? new Map<string, string>();
    this.files.set(threadId, checkout);
    const now = checkout.get(write.path);
    const still = write.expected.kind === "absent" ? now === undefined : now !== undefined && versionOf(now) === write.expected.version;
    if (!still) return { kind: "conflict", current: now === undefined ? null : { version: versionOf(now), text: now } };
    if (write.text === null) checkout.delete(write.path);
    else checkout.set(write.path, write.text);
    return { kind: "saved", version: write.text === null ? null : versionOf(write.text) };
  }
}

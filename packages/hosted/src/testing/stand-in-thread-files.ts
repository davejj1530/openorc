/**
 * Files in a hosted thread's messages. Today's server takes `fileIds` on a message and attaches each finished upload of
 * the sender's once, in the order they finished uploading; the stand-in attaches them in the order named, which is what
 * the server's files unit keeps (contract "Files in a message"). With the `files` capability set, it also keeps the rest
 * of that unit: a thread create sent again under its `requestId` answered as before, and a queued message's files taken
 * over by its edited copy, only from a cancelled message of the same thread and author. Without capabilities,
 * `GET /hosted/capabilities` is a 404, as on a server that predates it.
 */
import type { UploadedFile } from "../wire-files.js";
import { SUBTHREADS_FULL } from "./stand-in-thread-placement.js";

type Reply = { status: number; body: unknown };
type Availability = { available: true } | { available: false; reason: string };

/** The uploads' side: attach finished uploads to one message, all or none, and release one from a withdrawn message. */
export interface ThreadUploads {
  attach(input: { who: string; space: string; ids: string[]; messageId: string; projectId: string }): UploadedFile[] | Reply;
  release(id: string, messageId: string): boolean;
}

/** A message as the files rules need it. */
interface Sent {
  id: string;
  author: string;
  state: string;
  files: UploadedFile[];
}

const CHANGED_START: Reply = { status: 409, body: { message: "This thread was already started with different details.", code: "thread_request_conflict", statusCode: 409 } };

export class StandInThreadFiles {
  /** What `GET /hosted/capabilities` answers; null answers 404. */
  capabilities: Record<string, Availability> | null = null;
  uploads: ThreadUploads | null = null;
  readonly #starts = new Map<string, { digest: string; reply: Reply }>();

  get enabled(): boolean {
    return this.capabilities?.["files"]?.available === true;
  }

  /** For a thread whose family is `full`, New subthread is held in the server's words. */
  capabilityReply(full = false): Reply {
    if (!this.capabilities) return { status: 404, body: { message: "Cannot GET /hosted/capabilities", error: "Not Found", statusCode: 404 } };
    const held = full && this.capabilities["personSubthreads"]?.available ? { personSubthreads: { available: false, reason: SUBTHREADS_FULL } } : {};
    return { status: 200, body: { version: 1, features: { ...this.capabilities, ...held } } };
  }

  /** The files a new message names, attached to it; a refusal attaches none. A cancelled message's files move only once the unit is on. */
  claim(input: { who: string; space: string; projectId: string; messageId: string; ids: unknown; thread: readonly Sent[] }): UploadedFile[] | Reply {
    const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string") : [];
    if (!ids.length) return [];
    if (!this.uploads) return { status: 400, body: { message: "Attach files you uploaded for a hosted thread, once each.", statusCode: 400 } };
    if (this.enabled)
      for (const old of input.thread) if (old.state === "cancelled" && old.author === input.who) for (const file of old.files) if (ids.includes(file.id)) this.uploads.release(file.id, old.id);
    return this.uploads.attach({ who: input.who, space: input.space, ids, messageId: input.messageId, projectId: input.projectId });
  }

  /** A create named by `requestId` answers as it first did; the same id with other details is refused. */
  replayStart(who: string, space: string, body: Record<string, unknown>): Reply | null {
    const requestId = body["requestId"];
    if (!this.enabled || typeof requestId !== "string") return null;
    const known = this.#starts.get(JSON.stringify([who, space, requestId]));
    if (!known) return null;
    return known.digest === digestOf(body) ? known.reply : CHANGED_START;
  }

  rememberStart(who: string, space: string, body: Record<string, unknown>, reply: Reply): void {
    const requestId = body["requestId"];
    if (!this.enabled || typeof requestId !== "string" || reply.status >= 300) return;
    this.#starts.set(JSON.stringify([who, space, requestId]), { digest: digestOf(body), reply });
  }
}

function digestOf(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

/** Where the thread's log names a message's file, as the server's `attachedPath` writes it. */
export function attachedPath(file: Pick<UploadedFile, "id" | "name">): string {
  return `/hosted/files/${file.id}/${file.name}`;
}

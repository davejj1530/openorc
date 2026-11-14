import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UploadedFile } from "../wire-files.js";
import { expiredUpload, fileRefusal, finishFile, MAX_FILE_BYTES, newUpload, uploadName, type FileReply, type StoredUpload } from "./stand-in-file-data.js";
import { StandInUploadBytes } from "./stand-in-upload-bytes.js";
import type { StandInSpaces } from "./stand-in-spaces.js";
import { fileInputRefusal, signFilePartsInput, startFileInput } from "./stand-in-file-input.js";
import type { StandInChat } from "./stand-in-chat.js";

/** Multipart storage and authorization use the same listener as the fixture API. */
export class StandInUploads {
  readonly #rows = new Map<string, StoredUpload>();
  readonly #secret = randomUUID();
  readonly #bytes: StandInUploadBytes;

  constructor(private readonly deps: { spaces: StandInSpaces; chat: StandInChat; origin(): string }) {
    this.#bytes = new StandInUploadBytes({ ...deps, secret: this.#secret, rows: this.#rows });
  }

  raw(request: IncomingMessage, response: ServerResponse, holder: (token: string) => string | null): Promise<boolean> {
    return this.#bytes.answer(request, response, holder);
  }

  expire(id: string): void {
    const row = this.#rows.get(id);
    if (row) row.created = Date.now() - 25 * 60 * 60 * 1000;
  }

  async route(method: string, path: string, who: string, body: Record<string, unknown>, named: string | null): Promise<FileReply | null> {
    const match = /^\/uploads(?:\/([^/]+)(?:\/(parts|complete))?)?$/.exec(path);
    if (!match) return null;
    const space = this.deps.spaces.resolve(who, named);
    if (typeof space !== "string") return space;
    if (method === "POST" && !match[1]) return this.#start(who, space, body);
    const row = this.#rows.get(match[1] ?? "");
    if (!row || row.who !== who || row.space !== space) return fileRefusal(404, "That upload isn't here.");
    return this.#change(row, method, match[2], body);
  }

  #change(row: StoredUpload, method: string, action: string | undefined, body: Record<string, unknown>): FileReply | Promise<FileReply> | null {
    if (method === "DELETE" && !action) return this.#cancel(row);
    if (expiredUpload(row)) return fileRefusal(409, "This upload expired. Retry to upload the file again.");
    if (method === "POST" && action === "parts") return this.#parts(row, body);
    if (method === "POST" && action === "complete") return this.#complete(row);
    return null;
  }

  /** Validate the whole set before attaching any file, preserving the message's selected order. */
  attach(input: { who: string; space: string; ids: string[]; messageId: string; projectId: string }): UploadedFile[] | FileReply {
    const rows = input.ids.map((id) => this.#rows.get(id));
    if (
      rows.some((row) => !row?.file || expiredUpload(row) || row.who !== input.who || row.space !== input.space || row.conversationId || (row.attached && row.attached.messageId !== input.messageId))
    )
      return fileRefusal(400, "Attach files you uploaded for a hosted thread, once each.");
    if (new Set(input.ids).size !== input.ids.length) return fileRefusal(400, "Attach files you uploaded for a hosted thread, once each.");
    for (const row of rows) row!.attached = { messageId: input.messageId, projectId: input.projectId };
    return rows.map((row) => row!.file!);
  }

  /** A withdrawn message gives up one of its files, so its edited copy can take it. */
  release(id: string, messageId: string): boolean {
    const row = this.#rows.get(id);
    if (row?.attached?.messageId !== messageId) return false;
    row.attached = null;
    return true;
  }

  #start(who: string, space: string, body: Record<string, unknown>): FileReply {
    const parsed = startFileInput.safeParse(body);
    if (!parsed.success) return fileInputRefusal(parsed.error);
    const input = parsed.data;
    if (!input.bytes) return fileRefusal(400, "That file is empty.");
    if (input.bytes > MAX_FILE_BYTES) return { status: 413, body: { message: "Keep files under 500 MB.", code: "file_too_large", maxBytes: MAX_FILE_BYTES } };
    const conversationId = "conversationId" in input ? input.conversationId : null;
    if (conversationId) {
      const read = this.deps.chat.route({ method: "GET", path: `/chat/conversations/${encodeURIComponent(conversationId)}`, query: new URLSearchParams(), space }, who, {});
      if (read?.status !== 200) return read ?? fileRefusal(404, "That conversation isn't here.");
    }
    const requestId = input.requestId ?? null;
    const name = uploadName(input.name);
    const existing = requestId ? [...this.#rows.values()].find((row) => row.who === who && row.space === space && row.requestId === requestId) : null;
    if (existing) return this.#replay(existing, { name, bytes: input.bytes, conversationId });
    const row = newUpload({ who, space, name, bytes: input.bytes, conversationId, requestId });
    this.#rows.set(row.plan.id, row);
    return { status: 201, body: row.plan };
  }

  #replay(row: StoredUpload, wanted: Pick<StoredUpload, "name" | "bytes" | "conversationId">): FileReply {
    if (row.name !== wanted.name || row.bytes !== wanted.bytes || row.conversationId !== wanted.conversationId)
      return fileRefusal(409, "That upload request id was already used for a different file.", "upload_request_conflict");
    if (expiredUpload(row)) return fileRefusal(409, "This upload expired. Retry to upload the file again.");
    return { status: 201, body: row.plan };
  }

  #parts(row: StoredUpload, body: Record<string, unknown>): FileReply {
    if (row.file) return fileRefusal(409, "That upload is already finished.");
    const parsed = signFilePartsInput.safeParse(body);
    if (!parsed.success) return fileInputRefusal(parsed.error);
    const { parts } = parsed.data;
    if (parts.some((part) => part > row.plan.parts)) return fileRefusal(400, `That upload has ${row.plan.parts} parts.`);
    return {
      status: 200,
      body: {
        urls: parts.map((part) => {
          row.signed.add(part);
          return { part, url: `${this.deps.origin()}/__files/${this.#secret}/${row.plan.id}/${part}` };
        }),
      },
    };
  }

  async #complete(row: StoredUpload): Promise<FileReply> {
    if (row.file) return { status: 200, body: row.file };
    if (!row.signed.size) return fileRefusal(409, "Send the file's parts first.");
    if (row.chunks.size !== row.plan.parts) return fileRefusal(409, "Some of the file hasn't arrived yet.");
    return { status: 200, body: await finishFile(row) };
  }

  #cancel(row: StoredUpload): FileReply {
    if (!row.attached) {
      row.expired = true;
      row.chunks.clear();
      row.original = null;
      row.thumbnail = null;
    }
    return { status: 204, body: null };
  }
}

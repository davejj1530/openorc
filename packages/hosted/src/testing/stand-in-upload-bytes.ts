import type { IncomingMessage, ServerResponse } from "node:http";
import { expiredUpload, type StoredUpload } from "./stand-in-file-data.js";
import type { StandInSpaces } from "./stand-in-spaces.js";
import type { StandInChat } from "./stand-in-chat.js";

export class StandInUploadBytes {
  constructor(private readonly deps: { rows: Map<string, StoredUpload>; secret: string; spaces: StandInSpaces; chat: StandInChat }) {}

  async answer(request: IncomingMessage, response: ServerResponse, holder: (token: string) => string | null): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://stand-in");
    if (request.method === "PUT" && url.pathname.startsWith("/__files/")) {
      await this.#put(request, response, url.pathname);
      return true;
    }
    if (request.method !== "GET") return false;
    const file = readPath(url);
    return file ? this.#get(request, response, holder, file) : false;
  }

  #get(request: IncomingMessage, response: ServerResponse, holder: (token: string) => string | null, file: FileRead): boolean {
    const token = /^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim() ?? "";
    const who = holder(token);
    if (!who) return reply(response, 401, "Unauthorized");
    const named = request.headers["x-openorc-space"];
    const space = this.deps.spaces.resolve(who, typeof named === "string" ? named : null);
    if (typeof space !== "string") return reply(response, 403, "You're not in this organization.");
    const row = this.deps.rows.get(file.id);
    if (!row || Boolean(row.conversationId) !== file.chat || !this.#readable(row, who, space)) return reply(response, 404, "That file isn't here.");
    const bytes = file.thumbnail ? row.thumbnail : row.original;
    if (!bytes) return reply(response, 404, file.thumbnail ? "That file has no thumbnail." : "That file isn't here.");
    return this.#serve(request, response, row, bytes, file.thumbnail, file.download);
  }

  #readable(row: StoredUpload, who: string, space: string): boolean {
    if (row.space !== space || !row.file || expiredUpload(row)) return false;
    if (row.conversationId) {
      const read = this.deps.chat.route({ method: "GET", path: `/chat/conversations/${encodeURIComponent(row.conversationId)}`, query: new URLSearchParams(), space }, who, {});
      return read?.status === 200 && Boolean(row.attached || row.who === who);
    }
    if (row.attached) return this.deps.spaces.canRead(space, row.attached.projectId, who);
    return row.who === who;
  }

  async #put(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const [, , secret, id, rawPart] = path.split("/");
    const row = this.deps.rows.get(id ?? "");
    const part = Number(rawPart);
    if (secret !== this.deps.secret || !row || expiredUpload(row) || !row.signed.has(part) || row.file) {
      reply(response, 403, "This upload isn't available.");
      return;
    }
    const wanted = Math.min(row.plan.partBytes, row.bytes - (part - 1) * row.plan.partBytes);
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > wanted) break;
        chunks.push(buffer);
      }
    } catch (error) {
      if (request.aborted) return;
      throw error;
    }
    if (bytes !== wanted || request.headers["content-length"] !== String(wanted)) {
      reply(response, 400, "Some of the file hasn't arrived yet.");
      return;
    }
    row.chunks.set(part, Buffer.concat(chunks));
    response.writeHead(200, { etag: `"part-${part}"` });
    response.end();
  }

  #serve(request: IncomingMessage, response: ServerResponse, row: StoredUpload, bytes: Buffer, thumbnail: boolean, download: boolean): boolean {
    const range = rangeOf(request.headers.range, bytes.length);
    if (range === false) {
      response.writeHead(416, { "content-range": `bytes */${bytes.length}` });
      response.end();
      return true;
    }
    const { start, end } = range ?? { start: 0, end: bytes.length - 1 };
    response.writeHead(range ? 206 : 200, {
      "content-type": thumbnail ? "image/webp" : row.file!.contentType,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "content-disposition": `${download || row.file!.kind === "file" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(row.file!.name)}`,
      ...(range && { "content-range": `bytes ${start}-${end}/${bytes.length}` }),
    });
    response.end(bytes.subarray(start, end + 1));
    return true;
  }
}

interface FileRead {
  id: string;
  chat: boolean;
  thumbnail: boolean;
  download: boolean;
}
function readPath(url: URL): FileRead | null {
  const chat = /^\/chat\/files\/([^/]+)(\/thumbnail)?$/.exec(url.pathname);
  const original = /^\/hosted\/files\/([^/]+)\/[^/]+$/.exec(url.pathname);
  const thumbnail = /^\/hosted\/thumbnails\/([^/]+)$/.exec(url.pathname);
  const match = chat ?? original ?? thumbnail;
  return match ? { id: match[1]!, chat: Boolean(chat), thumbnail: Boolean(chat?.[2] || thumbnail), download: url.searchParams.has("download") } : null;
}

function rangeOf(value: string | undefined, bytes: number): { start: number; end: number } | false | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes - 1) : bytes - 1;
  return start <= end && start < bytes ? { start, end } : false;
}

function reply(response: ServerResponse, status: number, message: string): true {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ message, statusCode: status }));
  return true;
}

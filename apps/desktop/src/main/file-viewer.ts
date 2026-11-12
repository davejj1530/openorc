import { createReadStream, type Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ipcMain, protocol, shell } from "electron";
import { FILE_SCHEME, verifyFileUrl } from "@openorc/core/file-url";
import { fileExtension, fileMedia, OTHER_MEDIA } from "@openorc/protocol";

/** A served file may be painted or played and nothing more. The PDF viewer is a page of its own and gets no policy. */
const INERT = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
/** What Windows runs when a file is opened. Elsewhere the execute bit says so. */
const WINDOWS_PROGRAMS = new Set(["exe", "com", "scr", "msi", "lnk", "bat", "cmd", "ps1", "vbs", "hta", "reg"]);

type ByteRange = { start: number; end: number } | "whole" | "unsatisfiable";

/** The one `bytes=` range a media element asks for when it seeks. A malformed or multi-range header gets the whole file. */
function byteRange(header: string | null, size: number): ByteRange {
  const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "whole";
  if (match[1] === "") {
    const length = Math.min(Number(match[2]), size);
    return length === 0 ? "unsatisfiable" : { start: size - length, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || end < start ? "unsatisfiable" : { start, end };
}

/**
 * Where main opens a file the core named. On this computer that is the path itself. A core inside a WSL distribution
 * names Linux paths, which main opens through the share Windows mounts for the distribution.
 */
export type OpenedFile = (path: string) => { file: string; shared: boolean };
const asNamed: OpenedFile = (path) => ({ file: path, shared: false });

/** The file a signed path names now, or null once it is gone, a folder, or a link put in its place since the core signed it. */
async function regularFile(path: string, shared = false): Promise<Stats | null> {
  // A real path read through the share comes back as Windows spells it, never as the path asked for, so there a link
  // is told by what the entry itself is.
  if (shared) {
    const entry = await lstat(path).catch(() => null);
    return entry?.isFile() ? entry : null;
  }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  return (await realpath(path).catch(() => null)) === path ? info : null;
}

/** Bytes of one file the core signed a URL for, as the file panel's viewers load them. Only that signature names a file. */
export async function fileResponse(request: Request, key: string, opened: OpenedFile = asNamed): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const path = verifyFileUrl(key, request.url);
  if (!path) return new Response(null, { status: 403 });
  const { file, shared } = opened(path);
  const info = await regularFile(file, shared);
  if (!info) return new Response(null, { status: 404 });
  const { media, mime } = fileMedia(path) ?? OTHER_MEDIA;
  const headers = new Headers({ "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Accept-Ranges": "bytes" });
  if (media !== "pdf") headers.set("Content-Security-Policy", INERT);
  const range = byteRange(request.headers.get("range"), info.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range === "whole" ? { start: 0, end: info.size - 1 } : range;
  if (range !== "whole") headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  headers.set("Content-Length", String(info.size === 0 ? 0 : end - start + 1));
  const body = info.size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream);
  return new Response(body, { status: range === "whole" ? 200 : 206, headers });
}

const isProgram = (path: string, mode: number): boolean => (process.platform === "win32" ? WINDOWS_PROGRAMS.has(fileExtension(path)) : (mode & 0o111) !== 0);

/** Why the file did not open in its default app, or "" when it did. A program stays closed: the panel shows what agents wrote and never runs it. */
async function openProblem(path: string, opened: OpenedFile): Promise<string> {
  const { file, shared } = opened(path);
  const info = await regularFile(file, shared);
  if (!info) return "Could not open this file.";
  if (isProgram(path, info.mode)) return "Programs can’t be opened from here.";
  return (await shell.openPath(file)) ? "Could not open this file." : "";
}

/** Serves the file scheme, and opens a served file in its default app, each only for a URL the core signed with `key`. */
export function installFileViewer(key: string, isAppOrigin: (url: string) => boolean, opened: OpenedFile = asNamed): void {
  protocol.handle(FILE_SCHEME, (request) => fileResponse(request, key, opened));
  ipcMain.handle("shell:openFile", (event, url: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can open files.");
    const path = typeof url === "string" ? verifyFileUrl(key, url) : null;
    if (!path) throw new Error("This URL names no file.");
    return openProblem(path, opened);
  });
}

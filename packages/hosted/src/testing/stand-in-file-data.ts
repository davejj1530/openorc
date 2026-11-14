import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { UploadedFile, UploadPlan } from "../wire-files.js";
import { fileKind } from "./stand-in-file-kind.js";

export interface StoredUpload {
  plan: UploadPlan;
  who: string;
  space: string;
  name: string;
  bytes: number;
  conversationId: string | null;
  requestId: string | null;
  created: number;
  expired: boolean;
  signed: Set<number>;
  chunks: Map<number, Buffer>;
  file: UploadedFile | null;
  original: Buffer | null;
  thumbnail: Buffer | null;
  attached: { messageId: string; projectId: string } | null;
}

export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const expiredUpload = (row: StoredUpload): boolean => row.expired || (!row.attached && Date.now() - row.created >= 24 * 60 * 60 * 1000);
export type FileReply = { status: number; body: unknown };
export const fileRefusal = (status: number, message: string, code?: string): FileReply => ({ status, body: { message, statusCode: status, ...(code && { code }) } });

export function newUpload(input: Pick<StoredUpload, "who" | "space" | "name" | "bytes" | "conversationId" | "requestId">): StoredUpload {
  return {
    ...input,
    plan: { id: randomUUID(), partBytes: PART_BYTES, parts: Math.ceil(input.bytes / PART_BYTES) },
    created: Date.now(),
    expired: false,
    signed: new Set(),
    chunks: new Map(),
    file: null,
    original: null,
    thumbnail: null,
    attached: null,
  };
}

/** The fixture decodes only bounded raster previews; the original is retained byte for byte. */
export async function finishFile(row: StoredUpload): Promise<UploadedFile> {
  const original = Buffer.concat(Array.from({ length: row.plan.parts }, (_, i) => row.chunks.get(i + 1)!));
  row.original = original;
  let { kind, contentType } = fileKind(original);
  if (kind === "image" && original.length <= 50 * 1024 * 1024) {
    try {
      row.thumbnail = await sharp(original, { limitInputPixels: 100_000_000 }).rotate().resize(640, 640, { fit: "inside", withoutEnlargement: true }).webp().toBuffer();
    } catch {
      row.thumbnail = null;
    }
  }
  if (kind === "image" && !row.thumbnail) {
    kind = "file";
    contentType = "application/octet-stream";
  }
  const extension = contentType === "image/jpeg" ? ".jpg" : `.${contentType.split("/")[1]}`;
  const name = attachedName(row.name, kind === "image" ? extension : undefined);
  row.file = { id: row.plan.id, name, bytes: row.bytes, kind, contentType };
  return row.file;
}

function attachedName(name: string, extension?: string): string {
  const pictureName = /\.(png|jpe?g|gif|webp)$/i.test(name);
  if (extension) return pictureName ? name : name + extension;
  return pictureName ? `${name}.bin` : name;
}

export function uploadName(value: string): string {
  const base = value.replace(/\\/g, "/").split("/").at(-1)!;
  let name = Array.from(base)
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join("")
    .trim();
  while (Buffer.byteLength(name) > 200) name = Array.from(name).slice(1).join("");
  return name && name !== "." && name !== ".." ? name : "file";
}

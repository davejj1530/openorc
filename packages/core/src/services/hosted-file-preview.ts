import { imageSize } from "image-size";
import type { HostedFileRef } from "./hosted-file-record.js";
import type { HostedFileStore } from "./hosted-file-store.js";

const PREVIEW_BYTES = 1024 * 1024;
const PREVIEW_PIXELS = 2_000_000;
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** A small known raster can preview while uploading. Larger or undecodable originals keep their file chip. */
export async function hostedFilePreview(store: HostedFileStore, ref: HostedFileRef): Promise<{ contentType: string; data: string } | null> {
  const record = await store.get(ref);
  if (record.imported !== record.bytes || record.bytes > PREVIEW_BYTES || record.bytes === 0) return null;
  const source = await store.source(ref);
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < source.bytes; offset += 512 * 1024) pieces.push(await source.read(offset, Math.min(512 * 1024, source.bytes - offset)));
  const bytes = Buffer.concat(pieces, source.bytes);
  try {
    const image = imageSize(bytes);
    const type = image.type;
    if (!image.width || !image.height || image.width * image.height > PREVIEW_PIXELS || (type !== "png" && type !== "jpg" && type !== "webp")) return null;
    return { contentType: MIME[type], data: bytes.toString("base64") };
  } catch {
    return null;
  }
}

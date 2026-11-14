import { imageSize } from "image-size";

const THUMBNAIL_BYTES = 1024 * 1024;
const THUMBNAIL_EDGE = 640;
const UNREADABLE = "This image couldn't be opened. Try again.";

/** The thumbnail endpoint returns a bounded raster. Its headers alone are not a decoding guarantee. */
export async function hostedThumbnail(response: Response): Promise<{ contentType: "image/webp"; data: string }> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "image/webp") throw new Error(UNREADABLE);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error(UNREADABLE);
  for await (const chunk of hostedAssetChunks(response.body)) {
    size += chunk.byteLength;
    if (size > THUMBNAIL_BYTES) throw new Error(UNREADABLE);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    const image = imageSize(bytes);
    if (image.type !== "webp" || !image.width || !image.height || image.width > THUMBNAIL_EDGE || image.height > THUMBNAIL_EDGE) throw new Error(UNREADABLE);
  } catch {
    throw new Error(UNREADABLE);
  }
  return { contentType: "image/webp", data: bytes.toString("base64") };
}

export async function* hostedAssetChunks(body: NonNullable<Response["body"]>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Names from a message suggest a filename, never a directory or a control sequence in the native dialog. */
export function hostedDownloadName(name: string): string {
  const leaf =
    name
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\p{Cc}/gu, "")
      .trim() ?? "";
  let result = "";
  for (const character of leaf) {
    if (Buffer.byteLength(result + character) > 200) break;
    result += character;
  }
  return !result || result === "." || result === ".." ? "file" : result;
}

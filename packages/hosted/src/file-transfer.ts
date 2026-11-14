/** One bounded source read is in flight, independent of the server's multipart size. */
export const FILE_CHUNK_BYTES = 512 * 1024;
export const FILE_UPLOAD_FAILED = "This file didn't finish uploading. Retry or remove it.";

export interface FileByteSource {
  bytes: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Signed storage URLs receive bytes and their length only, never account headers. */
export async function putFilePart(input: {
  fetch: typeof fetch;
  url: string;
  source: FileByteSource;
  offset: number;
  bytes: number;
  signal: AbortSignal;
  progress(sent: number): void;
}): Promise<void> {
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(FILE_UPLOAD_FAILED);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        input.signal.throwIfAborted();
        const length = Math.min(FILE_CHUNK_BYTES, input.bytes - sent);
        if (!length) return controller.close();
        const chunk = await input.source.read(input.offset + sent, length);
        input.signal.throwIfAborted();
        if (chunk.byteLength !== length) throw new Error(FILE_UPLOAD_FAILED);
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        input.progress(sent);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  try {
    const request: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: { "content-length": String(input.bytes) },
      body,
      duplex: "half",
      signal: input.signal,
      redirect: "error",
      credentials: "omit",
    };
    const response = await input.fetch(url, request);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok || sent !== input.bytes) throw new Error(FILE_UPLOAD_FAILED);
  } catch {
    input.signal.throwIfAborted();
    throw new Error(FILE_UPLOAD_FAILED);
  } finally {
    if (!body.locked) await body.cancel().catch(() => undefined);
  }
}

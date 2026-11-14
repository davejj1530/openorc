import { expect, it, vi } from "vitest";
import { FILE_CHUNK_BYTES, FILE_UPLOAD_FAILED, putFilePart } from "./file-transfer.js";

it("streams a part in bounded reads with backpressure, without account headers", async () => {
  const bytes = 8 * 1024 * 1024 + 37;
  const read = vi.fn(async (offset: number, length: number) => new Uint8Array(length).fill(offset % 251));
  const progress: number[] = [];
  let received = 0;
  const fetchPart: typeof fetch = async (url, init) => {
    expect(String(url)).toBe("https://storage.example.test/signed-part");
    expect(init?.headers).toEqual({ "content-length": String(bytes) });
    expect(init?.redirect).toBe("error");
    if (!(init?.body instanceof ReadableStream)) throw new Error("Expected a stream");
    const reader = init.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      expect(part.value).toBeInstanceOf(Uint8Array);
      expect(part.value[0]).toBe((23 + received) % 251);
      received += part.value.byteLength;
      expect(read.mock.calls.length).toBeLessThanOrEqual(Math.ceil(received / FILE_CHUNK_BYTES) + 1);
    }
    return new Response(null, { status: 200 });
  };
  await putFilePart({
    fetch: fetchPart,
    url: "https://storage.example.test/signed-part",
    source: { bytes: 500 * 1024 * 1024, read },
    offset: 23,
    bytes,
    signal: new AbortController().signal,
    progress: (sent) => progress.push(sent),
  });
  expect(received).toBe(bytes);
  expect(progress.at(-1)).toBe(bytes);
  expect(Math.max(...read.mock.calls.map(([, length]) => length))).toBe(FILE_CHUNK_BYTES);
  expect(read.mock.calls.at(-1)).toEqual([23 + 8 * 1024 * 1024, 37]);
});

it("stops reading after cancellation and retains its reason", async () => {
  const control = new AbortController();
  const read = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
  const fetchPart: typeof fetch = async (_url, init) => {
    if (!(init?.body instanceof ReadableStream)) throw new Error("Expected a stream");
    const reader = init.body.getReader();
    await reader.read();
    control.abort(new Error("Removed from this draft."));
    await reader.read();
    return new Response();
  };
  await expect(
    putFilePart({ fetch: fetchPart, url: "https://storage.example.test/part", source: { bytes: 10_000_000, read }, offset: 0, bytes: 10_000_000, signal: control.signal, progress: () => undefined }),
  ).rejects.toThrow("Removed from this draft.");
  expect(read.mock.calls.length).toBeLessThanOrEqual(2);
});

it.each([400, 403, 500])("makes a failed signed PUT retryable without leaking its address (%i)", async (status) => {
  const read = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
  await expect(
    putFilePart({
      fetch: async () => new Response("Storage details", { status }),
      url: "https://storage.example.test/part?secret=not-for-the-window",
      source: { bytes: 10, read },
      offset: 0,
      bytes: 10,
      signal: new AbortController().signal,
      progress: () => undefined,
    }),
  ).rejects.toThrow(FILE_UPLOAD_FAILED);
});

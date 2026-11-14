import "fake-indexeddb/auto";
import { HOSTED_FILE_CHUNK_BYTES, HOSTED_FILE_MAX_BYTES, type HostedDraftFile, type HostedFileDraft, type HostedFileRef } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { HostedAttachmentImports } from "./hosted-attachment-imports";
import { HostedAttachmentStore, hostedAttachmentKey } from "./hosted-attachment-store";
import type { HostedAttachmentPort } from "./hosted-attachment-transfer";

const draft: HostedFileDraft = {
  draftKey: "conversation",
  scope: { accountId: "person", apiOrigin: "https://api.example.com", spaceId: "space", destination: { kind: "hosted", projectId: "project", threadId: "thread" } },
};
const stores: HostedAttachmentStore[] = [];
const queues: HostedAttachmentImports[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function fixture() {
  const name = `hosted-files-${crypto.randomUUID()}`;
  const files = new Map<string, HostedDraftFile>();
  const bytes = new Map<string, Uint8Array[]>();
  const scoped = (ref: HostedFileRef) => `${hostedAttachmentKey(ref)}:${ref.id}`;
  const port: HostedAttachmentPort = {
    capture: vi.fn(async ({ scope }) => scope),
    state: vi.fn(async (input) => ({ files: [...files.entries()].filter(([key]) => key.startsWith(`${hostedAttachmentKey(input)}:`)).map(([, file]) => file) })),
    begin: vi.fn(async (input) => {
      const id = scoped(input);
      let file = files.get(id);
      if (!file) {
        const message = input.bytes > HOSTED_FILE_MAX_BYTES ? "Keep files under 500 MB." : null;
        file = {
          id: input.id,
          name: input.name,
          mime: input.mime,
          bytes: input.bytes,
          imported: 0,
          selectedAt: files.size,
          state: message ? { kind: "failed", message, retryable: false } : { kind: "importing" },
        };
        files.set(id, file);
      }
      return file;
    }),
    append: vi.fn(async (input) => {
      const id = scoped(input);
      const file = files.get(id);
      if (!file) throw new Error("Missing file");
      const chunk = Buffer.from(input.data, "base64");
      if (input.offset !== file.imported) throw new Error("Repeated bytes");
      bytes.set(id, [...(bytes.get(id) ?? []), chunk]);
      file.imported += chunk.byteLength;
      return { imported: file.imported };
    }),
    finish: vi.fn(async (input) => {
      const file = files.get(scoped(input));
      if (!file) throw new Error("Missing file");
      file.state = { kind: "ready", file: { id: `upload-${input.id}`, name: file.name, bytes: file.bytes, contentType: file.mime, kind: "file" } };
      return {};
    }),
    retry: vi.fn(async () => ({})),
    remove: vi.fn(async (input) => {
      files.delete(scoped(input));
      return {};
    }),
    accepted: vi.fn(async (input) => {
      files.delete(scoped(input));
      return {};
    }),
  };
  const queue = () => {
    const store = new HostedAttachmentStore(name);
    stores.push(store);
    const imports = new HostedAttachmentImports({ store, port, encode: async (blob) => Buffer.from(await blob.arrayBuffer()).toString("base64") });
    queues.push(imports);
    return { store, imports };
  };
  return { port, bytes, scoped, queue };
}

it("keeps the Blob before transfer, bounds chunks and preserves the selected order", async () => {
  const { queue, port, bytes, scoped } = fixture();
  const { store, imports } = queue();
  const original = new Uint8Array(HOSTED_FILE_CHUNK_BYTES * 2 + 37).fill(123);
  original[original.length - 1] = 77;
  const first = await imports.add(draft, new Blob([original]), "first.bin");
  const second = await imports.add(draft, new Blob(["Second"]), "second.txt");
  await imports.idle();
  expect(Buffer.concat(bytes.get(scoped(first)) ?? [])).toEqual(Buffer.from(original));
  const chunks = vi.mocked(port.append).mock.calls.map(([input]) => Buffer.from(input.data, "base64").length);
  expect(chunks).toEqual([HOSTED_FILE_CHUNK_BYTES, HOSTED_FILE_CHUNK_BYTES, 37, 6]);
  expect((await imports.files(draft)).map((file) => file.name)).toEqual(["first.bin", "second.txt"]);
  expect(await store.get(first)).toMatchObject({ blob: null, transfer: { kind: "stored" } });
  await imports.accepted(first);
  await imports.idle();
  expect(port.remove).not.toHaveBeenCalled();
  expect((await imports.files(draft)).map((file) => file.id)).toEqual([second.id]);
});

it("keeps a lost append refusal through navigation and restart, then resumes only on Retry", async () => {
  const { queue, port, bytes, scoped } = fixture();
  const first = queue();
  const append = vi.mocked(port.append).getMockImplementation();
  if (!append) throw new Error("Missing append fixture");
  vi.mocked(port.append).mockImplementationOnce(async (input) => {
    await append(input);
    throw new Error("The connection closed.");
  });
  const ref = await first.imports.add(draft, new Blob([new Uint8Array(HOSTED_FILE_CHUNK_BYTES + 11)]), "notes.bin");
  await first.imports.idle();
  expect((await first.imports.files(draft))[0]?.state).toEqual({ kind: "failed", message: "The connection closed.", retryable: true });
  await first.imports.close();
  const second = queue();
  await second.imports.files(draft);
  await second.imports.idle();
  expect(port.append).toHaveBeenCalledTimes(1);
  await second.imports.retry(ref);
  await second.imports.idle();
  expect(port.append).toHaveBeenCalledTimes(2);
  expect(Buffer.concat(bytes.get(scoped(ref)) ?? []).length).toBe(HOSTED_FILE_CHUNK_BYTES + 11);
  expect((await second.imports.files(draft))[0]?.state.kind).toBe("ready");
});

it("finishes only one import at a time and does not resurrect a removed file", async () => {
  const { queue, port } = fixture();
  const { imports } = queue();
  const begin = vi.mocked(port.begin).getMockImplementation();
  if (!begin) throw new Error("Missing begin fixture");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(port.begin).mockImplementationOnce(async (input) => {
    const result = await begin(input);
    await held;
    return result;
  });
  const first = await imports.add(draft, new Blob(["First"]), "first.txt");
  await vi.waitFor(() => expect(port.begin).toHaveBeenCalledTimes(1));
  await imports.add(draft, new Blob(["Second"]), "second.txt");
  expect(port.begin).toHaveBeenCalledTimes(1);
  await imports.remove(first);
  release();
  await imports.idle();
  expect(vi.mocked(port.append).mock.calls.map(([input]) => input.id)).not.toContain(first.id);
  expect((await imports.files(draft)).map((file) => file.name)).toEqual(["second.txt"]);
  expect(port.remove).toHaveBeenCalledOnce();
});

it("keeps accounts and origins separate and refuses a large file without reading its bytes", async () => {
  const { queue, port } = fixture();
  const { imports } = queue();
  const blob = new Blob(["Small"]);
  Object.defineProperty(blob, "size", { value: HOSTED_FILE_MAX_BYTES + 1 });
  const slice = vi.spyOn(blob, "slice");
  await imports.add(draft, blob, "large.bin");
  await imports.idle();
  expect((await imports.files(draft))[0]?.state).toEqual({ kind: "failed", message: "Keep files under 500 MB.", retryable: false });
  expect(slice).not.toHaveBeenCalled();
  expect(port.append).not.toHaveBeenCalled();
  expect(await imports.files({ ...draft, scope: { ...draft.scope, accountId: "second" } })).toEqual([]);
  expect(await imports.files({ ...draft, scope: { ...draft.scope, apiOrigin: "https://second.example.com" } })).toEqual([]);
});

it("resumes an interrupted import after restart without an automatic retry of a failed upload", async () => {
  const { queue, port, bytes, scoped } = fixture();
  const first = queue();
  const append = vi.mocked(port.append).getMockImplementation();
  if (!append) throw new Error("Missing append fixture");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(port.append).mockImplementationOnce(async (input) => {
    const result = await append(input);
    await held;
    return result;
  });
  const ref = await first.imports.add(draft, new Blob([new Uint8Array(HOSTED_FILE_CHUNK_BYTES + 29)]), "restart.bin");
  await vi.waitFor(() => expect(port.append).toHaveBeenCalledOnce());
  const stopped = first.imports.close();
  release();
  await stopped;
  const second = queue();
  await second.imports.files(draft);
  await second.imports.idle();
  expect(vi.mocked(port.append).mock.calls.map(([input]) => input.offset)).toEqual([0, HOSTED_FILE_CHUNK_BYTES]);
  expect(Buffer.concat(bytes.get(scoped(ref)) ?? []).length).toBe(HOSTED_FILE_CHUNK_BYTES + 29);
});

it("keeps a failed local write with that file and retries its retained Blob", async () => {
  const { queue, port } = fixture();
  const { store, imports } = queue();
  vi.spyOn(store, "put").mockRejectedValueOnce(new Error("This file couldn't be kept on this device. Free some storage and retry."));
  const ref = await imports.add(draft, new Blob(["Kept in this window"]), "notes.txt");
  expect((await imports.files(draft))[0]?.state).toMatchObject({ kind: "failed", retryable: true });
  expect(port.begin).not.toHaveBeenCalled();
  await imports.retry(ref);
  await imports.idle();
  expect((await imports.files(draft))[0]?.state.kind).toBe("ready");
});

it("retries a refused removal without reuploading and cleans up core files after browser storage is lost", async () => {
  const { queue, port } = fixture();
  const { store, imports } = queue();
  const ref = await imports.add(draft, new Blob(["Original"]), "notes.txt");
  await imports.idle();
  await store.remove(ref);
  vi.mocked(port.remove).mockRejectedValueOnce(new Error("The connection closed."));
  await imports.remove(ref);
  await imports.idle();
  expect((await imports.files(draft))[0]?.state).toEqual({ kind: "failed", message: "The connection closed.", retryable: true });
  await imports.retry(ref);
  await imports.idle();
  expect(port.begin).toHaveBeenCalledOnce();
  expect(port.remove).toHaveBeenCalledTimes(2);
  expect(await imports.files(draft)).toEqual([]);
});

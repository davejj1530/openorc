import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HOSTED_FILE_CHUNK_BYTES, type NewHostedFile } from "./hosted-file-record.js";
import { HostedFileStore } from "./hosted-file-store.js";

let directory: string;
let store: HostedFileStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-file-store-"));
  store = new HostedFileStore(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const input = (bytes: number): NewHostedFile => ({
  id: randomUUID(),
  draftKey: "first-project-draft",
  name: "notes.txt",
  bytes,
  mime: "text/plain",
  scope: { accountId: "example-person", apiOrigin: "https://cloud.example.test", spaceId: "example-space", destination: { kind: "hosted", projectId: "example-project" } },
});

it("restores durable bytes, the upload request and part receipts across a new process", async () => {
  const draft = input(HOSTED_FILE_CHUNK_BYTES + 5);
  await store.begin(draft);
  await store.append(draft, 0, Buffer.alloc(HOSTED_FILE_CHUNK_BYTES, 12));
  store = new HostedFileStore(directory);
  expect(await store.get(draft)).toMatchObject({ imported: HOSTED_FILE_CHUNK_BYTES, phase: "importing", requestId: draft.id });
  await store.append(draft, HOSTED_FILE_CHUNK_BYTES, Buffer.from("last!"));
  await store.seal(draft);
  await store.update(draft, (record) => ({ ...record, plan: { id: "upload-one", partBytes: HOSTED_FILE_CHUNK_BYTES, parts: 2 }, completedParts: [1] }));
  store = new HostedFileStore(directory);
  expect(await store.get(draft)).toMatchObject({ phase: "uploading", completedParts: [1], plan: { id: "upload-one" } });
  const source = await store.source(draft);
  expect(source.bytes).toBe(draft.bytes);
  expect(Buffer.from(await source.read(HOSTED_FILE_CHUNK_BYTES, 5)).toString()).toBe("last!");
  const account = (await readdir(path.join(directory, "hosted-files")))[0]!;
  expect((await stat(path.join(directory, "hosted-files", account, `${draft.id}.bytes`))).mode & 0o777).toBe(0o600);
});

it("replays a lost chunk response once and refuses changed or out-of-order bytes", async () => {
  const draft = input(6);
  await store.begin(draft);
  await Promise.all([store.append(draft, 0, Buffer.from("abc")), store.append(draft, 0, Buffer.from("abc"))]);
  expect(await store.get(draft)).toMatchObject({ imported: 3 });
  await expect(store.append(draft, 0, Buffer.from("xyz"))).rejects.toThrow("saved bytes don't match");
  await expect(store.append(draft, 4, Buffer.from("ef"))).rejects.toThrow("hasn't finished saving");
  await expect(store.seal(draft)).rejects.toThrow("hasn't finished saving");
  await store.append(draft, 3, Buffer.from("def"));
  await store.seal(draft);
  expect(Buffer.from(await (await store.source(draft)).read(0, 6)).toString()).toBe("abcdef");
});

it("separates accounts, origins and drafts even when the same file ID is supplied", async () => {
  const draft = input(3);
  await store.begin(draft);
  await store.append(draft, 0, Buffer.from("abc"));
  for (const scope of [
    { ...draft.scope, accountId: "another-person" },
    { ...draft.scope, apiOrigin: "https://another.example.test" },
  ]) {
    expect(await store.list({ ...draft, scope })).toEqual([]);
    await expect(store.get({ ...draft, scope })).rejects.toThrow("That file isn't in this draft.");
  }
  await expect(store.get({ ...draft, draftKey: "a-different-draft" })).rejects.toThrow("That file isn't in this draft.");
  await expect(store.get({ ...draft, id: "../../private" })).rejects.toThrow("That file isn't in this draft.");
  expect((await store.list(draft)).map((record) => record.id)).toEqual([draft.id]);
});

it("retains the selection order even when uploads finish in reverse order", async () => {
  const first = input(1);
  const second = { ...input(1), draftKey: first.draftKey, scope: first.scope };
  await store.begin(first);
  await store.begin(second);
  for (const draft of [second, first]) {
    await store.append(draft, 0, Buffer.from("a"));
    await store.seal(draft);
  }
  store = new HostedFileStore(directory);
  expect((await store.list(first)).map((record) => record.id)).toEqual([first.id, second.id]);
  await store.remove(first);
  await store.remove(first);
  expect((await store.list(second)).map((record) => record.id)).toEqual([second.id]);
});

it("keeps an oversized file's refusal without copying its bytes", async () => {
  const draft = input(500 * 1024 * 1024 + 1);
  expect(await store.begin(draft)).toMatchObject({ phase: "failed", failure: { message: "Keep files under 500 MB.", retryable: false } });
  await expect(store.append(draft, 0, Buffer.from("a"))).rejects.toThrow("saved bytes don't match");
  const account = (await readdir(path.join(directory, "hosted-files")))[0]!;
  expect(await readdir(path.join(directory, "hosted-files", account))).toEqual([`${draft.id}.json`]);
});

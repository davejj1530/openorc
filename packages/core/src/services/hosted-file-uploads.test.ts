import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { OpenOrc } from "../openorc.js";
import { HostedFileStore } from "./hosted-file-store.js";
import { HOSTED_FILE_CHUNK_BYTES, type HostedFileRecord, type NewHostedFile } from "./hosted-file-record.js";
import { HostedFileUploads } from "./hosted-file-uploads.js";

const EMAIL = "sender@example.com";
let directory: string;
let stand: StandIn;
let core: OpenOrc;
let store: HostedFileStore;
let uploads: HostedFileUploads;
let projectId: string;
const changed = vi.fn();

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-upload-drafts-"));
  stand = await standIn({ signup: "open" });
  projectId = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  let stored = "";
  core = await OpenOrc.create({
    dataDir: directory,
    ephemeral: true,
    transport: { push: () => undefined },
    accountServer: stand.url,
    accountSecrets: {
      load: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    shellProbe: async () => ({
      path: process.env.PATH ?? "",
      binaries: {
        claude: "/usr/bin/false",
        codex: "/usr/bin/false",
        opencode: "/usr/bin/false",
        omp: "/usr/bin/false",
        cursor: "/usr/bin/false",
        pi: "/usr/bin/false",
        antigravity: "/usr/bin/false",
        fx: "/usr/bin/false",
      },
    }),
    openBrowser: (url) => {
      void fetch(stand.signInPage(url, EMAIL), { redirect: "manual" });
    },
  });
  await core.account!.account.signIn();
  await vi.waitFor(() => expect(core.account!.spaces.status()).toMatchObject({ state: "ready" }));
  store = new HostedFileStore(directory);
  uploads = service();
});
afterEach(async () => {
  await uploads.close();
  await core.close();
  await stand.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function service() {
  return new HostedFileUploads({ store, account: () => core.account, changed });
}
function draft(name: string, bytes: number): NewHostedFile {
  return {
    id: randomUUID(),
    draftKey: "project-draft",
    name,
    bytes,
    mime: "application/octet-stream",
    scope: { accountId: `user-${EMAIL}`, apiOrigin: stand.url, spaceId: `personal-${EMAIL}`, destination: { kind: "hosted", projectId } },
  };
}
async function stage(name: string, bytes: number): Promise<HostedFileRecord> {
  const record = await uploads.begin(draft(name, bytes));
  for (let offset = 0; offset < bytes; offset += HOSTED_FILE_CHUNK_BYTES) await uploads.append(record, offset, Buffer.alloc(Math.min(HOSTED_FILE_CHUNK_BYTES, bytes - offset), 97));
  await uploads.finish(record);
  return record;
}
const settled = (ref: HostedFileRecord, phase: "ready" | "failed") => vi.waitFor(async () => expect(await store.get(ref)).toMatchObject({ phase }), { timeout: 5000 });

it("uploads one file at a time and retries only the failed part", async () => {
  const real = core.account!.files.part.bind(core.account!.files);
  let active = 0;
  let most = 0;
  let failed = false;
  const part = vi.spyOn(core.account!.files, "part").mockImplementation(async (...args) => {
    active++;
    most = Math.max(most, active);
    try {
      if (args[2] === 2 && !failed) {
        failed = true;
        throw new Error("This file didn't finish uploading. Retry or remove it.");
      }
      return await real(...args);
    } finally {
      active--;
    }
  });
  const first = await stage("first.bin", 8 * 1024 * 1024 + 5);
  const second = await stage("second.bin", 3);
  await settled(first, "failed");
  await settled(second, "ready");
  const id = (await store.get(first)).plan!.id;
  for (let i = 0; i < 3; i++) await uploads.state(first);
  expect(part.mock.calls.filter(([, plan, number]) => plan.id === id && number === 2)).toHaveLength(1);
  await uploads.retry(first);
  await settled(first, "ready");
  expect(part.mock.calls.filter(([, plan, number]) => plan.id === id && number === 1)).toHaveLength(1);
  expect(part.mock.calls.filter(([, plan, number]) => plan.id === id && number === 2)).toHaveLength(2);
  expect(most).toBe(1);
  expect((await uploads.state(first)).files.map((row) => row.name)).toEqual(["first.bin", "second.bin"]);
});

it("resumes a pending upload after restart without sending completed parts again", async () => {
  const real = core.account!.files.part.bind(core.account!.files);
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const part = vi.spyOn(core.account!.files, "part").mockImplementation(async (...args) => {
    if (args[2] === 1) return real(...args);
    entered();
    await new Promise<void>((_resolve, reject) => args[4].signal.addEventListener("abort", () => reject(args[4].signal.reason), { once: true }));
  });
  const file = await stage("restart.bin", 8 * 1024 * 1024 + 2);
  await waiting;
  await uploads.close();
  expect(await store.get(file)).toMatchObject({ phase: "uploading", completedParts: [1] });
  part.mockImplementation(real);
  store = new HostedFileStore(directory);
  uploads = service();
  await uploads.state(file);
  await settled(file, "ready");
  expect(part.mock.calls.filter(([, , number]) => number === 1)).toHaveLength(1);
  expect(part.mock.calls.filter(([, , number]) => number === 2)).toHaveLength(2);
});

it("removes an in-flight upload even when its start reply was lost", async () => {
  const real = core.account!.files.start.bind(core.account!.files);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const start = vi.spyOn(core.account!.files, "start").mockImplementationOnce(async (...args) => {
    await real(...args);
    entered();
    return new Promise((_resolve, reject) => args[2]!.addEventListener("abort", () => reject(args[2]!.reason), { once: true }));
  });
  const file = await stage("remove.bin", 3);
  await started;
  await uploads.remove(file);
  await vi.waitFor(async () => expect(await store.list(file)).toEqual([]));
  expect(start).toHaveBeenCalledTimes(2);
  expect(stand.requests.filter((request) => request.method === "DELETE" && request.path.startsWith("/uploads/"))).toHaveLength(1);
  expect((await uploads.state(file)).files).toEqual([]);
});

it("gives only an explicitly retried expired file a fresh upload ID", async () => {
  const real = core.account!.files.part.bind(core.account!.files);
  let expired = false;
  vi.spyOn(core.account!.files, "part").mockImplementation(async (...args) => {
    if (!expired) {
      expired = true;
      stand.uploads.expire(args[1].id);
    }
    return real(...args);
  });
  const file = await stage("expired.bin", 3);
  await settled(file, "failed");
  const previous = await store.get(file);
  expect(previous.failure?.message).toBe("This upload expired. Retry to upload the file again.");
  await uploads.retry(file);
  await settled(file, "ready");
  const next = await store.get(file);
  expect(next.plan!.id).not.toBe(previous.plan!.id);
  expect(next.requestId).not.toBe(previous.requestId);
});

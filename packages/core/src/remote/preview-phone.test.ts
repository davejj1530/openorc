import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { projects, teamDeletedThreads, threads } from "@openorc/db";
import type { PreviewCaptureOptions, PreviewHost, PreviewHostCapture, PreviewHostPage, RemotePush } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { ProtectedSecretStore } from "../services/extraction-credentials.js";
import { RemoteTestClient } from "./test-client.js";

const machine = { name: () => "Test Mac", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function memorySecrets(): ProtectedSecretStore {
  let value: string | null = null;
  return { load: async () => value, save: async (next) => void (value = next) };
}

/** A Mac whose Preview shows one page for one thread and paints a new frame for every capture. */
class FakeMac implements PreviewHost {
  page: PreviewHostPage = {
    pane: "0123456789ab",
    url: `http://127.0.0.1:47831/secret?code=abc&state=xyz#access_token=${TOKEN}`,
    title: `QA Secret ${TOKEN}`,
    loading: false,
    error: null,
    crashed: false,
  };
  threadId = "";
  captures = 0;
  async query(threadId: string) {
    return threadId === this.threadId ? this.page : null;
  }
  async capture(threadId: string, options: PreviewCaptureOptions): Promise<PreviewHostCapture | null> {
    if (threadId !== this.threadId) return null;
    this.captures++;
    return { kind: "frame", pane: this.page.pane, jpeg: new Uint8Array([0xff, 0xd8, this.captures]), width: options.width, height: 1000, digest: `d${this.captures}` };
  }
  onChange() {
    return () => undefined;
  }
  /** The threads main was told are gone. */
  readonly gone: string[] = [];
  async input() {
    return null;
  }
  threadGone(threadId: string) {
    this.gone.push(threadId);
  }
}

let folder: string;
let core: OpenOrc;
let mac: FakeMac;
let threadId: string;
let otherId: string;
let phone: RemoteTestClient;

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-preview-phone-"));
  mac = new FakeMac();
  core = await OpenOrc.create({
    dataDir: path.join(folder, "data"),
    ephemeral: true,
    transport: { push: () => {} },
    remoteSecrets: memorySecrets(),
    remoteNetwork: { port: 0, machine },
    preview: mac,
  });
  await core.remote.attach((request, origin) => core.handle(request, origin));
  await core.remote.configure(true);
  const project = projects.insert(core.db, { name: "Preview", rootPath: folder, defaultBranch: "main", gitRemote: null, settings: {} });
  const insert = (title: string) => threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" }).id;
  threadId = insert("Watched");
  otherId = insert("Other");
  mac.threadId = threadId;
  const paired = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
  if (typeof paired === "string") throw new Error(`refused: ${paired}`);
  phone = paired;
});

afterAll(async () => {
  phone?.close();
  await core?.close();
  await rm(folder, { recursive: true, force: true });
});

const previews = () => phone.pushes.filter((push): push is Extract<RemotePush, { type: "preview" }> => push.type === "preview");

it("reads a thread's Preview over the link, its address and title shaped", async () => {
  expect(await phone.call("preview.state", { threadId })).toEqual({
    open: true,
    pane: "0123456789ab",
    address: "http://127.0.0.1:47831/secret?code=[redacted:query]&state=[redacted:query]",
    title: "QA Secret [redacted:github-token]",
    phase: "live",
    error: null,
    frame: null,
  });
  expect(await phone.call("preview.state", { threadId: otherId })).toEqual({ open: false });
});

it("watches through its own session: a frame push, the frame as an asset, then no more once unwatched", async () => {
  expect(await phone.sessionMethod("preview.watch", { threadId, width: 786, pace: "lan" })).toMatchObject({ open: true, frame: null, title: "QA Secret [redacted:github-token]" });
  await phone.until(() => previews().length > 0);
  const told = previews().at(-1)!;
  expect(told).toMatchObject({ threadId, state: { open: true, address: expect.stringContaining("[redacted:query]"), frame: { seq: 1, width: 786, height: 1000 } } });
  expect(JSON.stringify(told)).not.toContain(TOKEN);
  expect(await phone.asset({ kind: "preview", threadId, seq: 1 })).toEqual({ mime: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 1]) });
  await phone.until(() => previews().some((push) => push.state.open && push.state.frame?.seq === 2), 3_000);
  await expect(phone.asset({ kind: "preview", threadId: otherId, seq: 1 })).rejects.toThrow("This page is not being watched.");
  expect(await phone.sessionMethod("preview.unwatch", {})).toBeNull();
  await expect(phone.asset({ kind: "preview", threadId, seq: 2 })).rejects.toThrow("This page is not being watched.");
  const captures = mac.captures;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(mac.captures).toBe(captures);
});

it("refuses a watch of a thread the Mac does not have", async () => {
  await expect(phone.sessionMethod("preview.watch", { threadId: "missing", width: 786, pace: "lan" })).rejects.toThrow("This thread is gone.");
});

it("refuses a watch of a thread a team deletion hid", async () => {
  const hidden = vi.spyOn(teamDeletedThreads, "has").mockImplementation((_db, id) => id === otherId);
  try {
    await expect(phone.sessionMethod("preview.watch", { threadId: otherId, width: 786, pace: "lan" })).rejects.toThrow("This thread is gone.");
  } finally {
    hidden.mockRestore();
  }
});

it("ends the watch when the watched thread is deleted: the phone hears why, captures stop, and main lets go of its pages", async () => {
  await phone.sessionMethod("preview.watch", { threadId, width: 786, pace: "lan" });
  await phone.until(() => previews().length > 0);
  await core.threads.delete(threadId);
  await phone.until(() => phone.pushes.some((push) => push.type === "preview.ended"));
  expect(phone.pushes.filter((push) => push.type === "preview.ended")).toEqual([{ type: "preview.ended", threadId, message: "This thread is gone." }]);
  expect(mac.gone).toEqual([threadId]);
  const captures = mac.captures;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(mac.captures).toBe(captures);
  await expect(phone.asset({ kind: "preview", threadId, seq: 1 })).rejects.toThrow("This page is not being watched.");
  await expect(phone.sessionMethod("preview.watch", { threadId, width: 786, pace: "lan" })).rejects.toThrow("This thread is gone.");
});

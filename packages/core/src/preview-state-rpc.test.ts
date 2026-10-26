import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects, teamDeletedThreads, threads } from "@openorc/db";
import type { CorePush, PreviewHost, PreviewHostPage } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let folder: string;
let core: OpenOrc;
let pushes: CorePush[];
let pages: Map<string, PreviewHostPage>;
let changed: (threadId: string, lifecycle: boolean) => void;

const host: PreviewHost = {
  query: vi.fn(async (threadId: string) => pages.get(threadId) ?? null),
  capture: vi.fn(async () => null),
  onChange: (listener) => {
    changed = listener;
    return () => undefined;
  },
  threadGone: () => undefined,
};

async function start(preview?: PreviewHost) {
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (push) => pushes.push(push as CorePush) }, ...(preview ? { preview } : {}) });
  const project = projects.insert(core.db, { name: "Preview", rootPath: folder, defaultBranch: "main", gitRemote: null, settings: {} });
  return threads.insert(core.db, { projectId: project.id, title: "Preview", agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-preview-state-"));
  pushes = [];
  pages = new Map();
  vi.mocked(host.query).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core?.close();
  await rm(folder, { recursive: true, force: true });
});

const call = rpcClient(() => core);
const page = (overrides: Partial<PreviewHostPage> = {}): PreviewHostPage => ({
  pane: "0123456789ab",
  url: "http://127.0.0.1:47831/tick",
  title: "QA Tick",
  loading: false,
  error: null,
  crashed: false,
  ...overrides,
});

it("answers closed when the core has no Preview host", async () => {
  const thread = await start();
  expect(await call("preview.state", { threadId: thread.id })).toEqual({ open: false });
});

it("reads the Mac's page as a state with no frame, its phase from loading, failure and crash", async () => {
  const thread = await start(host);
  expect(await call("preview.state", { threadId: thread.id })).toEqual({ open: false });
  pages.set(thread.id, page());
  expect(await call("preview.state", { threadId: thread.id })).toEqual({
    open: true,
    pane: "0123456789ab",
    address: "http://127.0.0.1:47831/tick",
    title: "QA Tick",
    phase: "live",
    error: null,
    frame: null,
  });
  pages.set(thread.id, page({ loading: true }));
  expect(await call("preview.state", { threadId: thread.id })).toMatchObject({ phase: "loading" });
  pages.set(thread.id, page({ error: "Nothing is listening on 127.0.0.1:47831 yet." }));
  expect(await call("preview.state", { threadId: thread.id })).toMatchObject({ phase: "failed", error: "Nothing is listening on 127.0.0.1:47831 yet." });
  pages.set(thread.id, page({ crashed: true, error: "The preview stopped (crashed). Reload to start it again." }));
  expect(await call("preview.state", { threadId: thread.id })).toMatchObject({ phase: "stopped" });
});

it("answers closed for a missing or team-deleted thread without asking main", async () => {
  const thread = await start(host);
  pages.set(thread.id, page());
  vi.spyOn(teamDeletedThreads, "has").mockImplementation((_db, id) => id === thread.id);
  expect(await call("preview.state", { threadId: thread.id })).toEqual({ open: false });
  expect(await call("preview.state", { threadId: "no-such-thread" })).toEqual({ open: false });
  expect(host.query).not.toHaveBeenCalled();
  await expect(call("preview.state", { threadId: "thread:../x" })).rejects.toThrow();
});

it("invalidates a thread's Preview when a page opens, closes or the shown tab changes, and not on every repaint", async () => {
  const thread = await start(host);
  pushes.length = 0;
  changed(thread.id, false);
  changed(thread.id, true);
  expect(pushes.filter((push) => push.type === "invalidate")).toEqual([{ type: "invalidate", keys: [`preview:${thread.id}`] }]);
});

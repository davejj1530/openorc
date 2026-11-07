import { Db, LedgerWriter, projects, threads } from "@openorc/db";
import { run } from "@openorc/git";
import { type Project, type Thread } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameCoalescer } from "../frames.js";
import { LifecycleService } from "./lifecycle.js";
import { RunService } from "./runs.js";
import { AppSettingsService } from "./settings.js";
import { ShellEnvironment } from "./shell-environment.js";
import { ThreadService } from "./threads.js";
import { WorkspaceService } from "./workspace.js";

vi.mock("@openorc/git", async (importOriginal) => ({ ...(await importOriginal<typeof import("@openorc/git")>()), run: vi.fn() }));

let db: Db;
let ledger: LedgerWriter;
let project: Project;
let lifecycle: LifecycleService;
let runs: RunService;
let threadService: ThreadService;
let appSettings: AppSettingsService;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  db = Db.memory();
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "Lifecycle fixture", rootPath: "/unused/lifecycle-fixture", defaultBranch: "main", gitRemote: null, settings: {} });
  const environment = new ShellEnvironment({ env: { ...process.env, OPENORC_CLAUDE_BIN: "/fixture/claude", OPENORC_CODEX_BIN: "/fixture/codex" } });
  runs = new RunService(
    db,
    ledger,
    new FrameCoalescer(() => {}),
    async () => {
      throw new Error("No provider should start");
    },
    () => {},
    log,
    {
      environment: () => environment.current(),
      brief: () => "",
      onRunFinished() {},
      onThreadTurn() {},
      notify() {},
      claudeVersion: async () => null,
    },
  );
  threadService = new ThreadService(
    db,
    runs,
    new WorkspaceService(db, { dataDir: "/unused/lifecycle-data" }, log),
    () => {},
    log,
    async () => null,
  );
  appSettings = new AppSettingsService(db);
  appSettings.set({ autoDoneDays: 1, autoArchiveDoneDays: 1, autoDoneOnPrMerge: true });
  lifecycle = new LifecycleService(db, () => {}, log);
  vi.mocked(run).mockResolvedValue({ stdout: JSON.stringify({ state: "MERGED" }), stderr: "", code: 0 });
  log.warn.mockClear();
});

afterEach(async () => {
  lifecycle.stop();
  await runs.closeAll();
  ledger.close();
  db.close();
  vi.clearAllMocks();
});

function insert(title: string): Thread {
  return threads.insert(db, { projectId: project.id, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
}

describe("conversation lifecycle", () => {
  it("keeps a PR badge through malformed process output and accepts the next valid state", async () => {
    const thread = insert("Recover the PR badge");
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/recovery", prState: "open" });
    for (const stdout of ["not JSON", "null", "[]", '{"state":null}', '{"state":7}', '{"state":"UNKNOWN"}']) {
      vi.mocked(run).mockResolvedValueOnce({ stdout, stderr: "", code: 0 });
      await lifecycle.pollPullRequests();
      expect(threads.get(db, thread.id)?.prState).toBe("open");
    }
    await lifecycle.pollPullRequests();
    expect(threads.get(db, thread.id)?.prState).toBe("merged");
  });

  it.each(["setting", "manual-active", "archive", "replacement", "deleted"] as const)("rechecks %s after a PR lookup before retaining merge completion", async (change) => {
    appSettings.set({ autoDoneDays: null, autoArchiveDoneDays: null });
    const thread = insert("Lookup raced a user change");
    threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/lookup", prState: "open" });
    let release!: () => void;
    vi.mocked(run).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { stdout: JSON.stringify({ state: "MERGED" }), stderr: "", code: 0 };
    });
    const polling = lifecycle.pollPullRequests();
    if (change === "setting") appSettings.set({ autoDoneOnPrMerge: false });
    if (change === "manual-active") threadService.update(thread.id, { done: false });
    if (change === "archive") threadService.update(thread.id, { archived: true });
    if (change === "replacement") threads.update(db, thread.id, { prUrl: "https://example.invalid/pull/replacement", prState: "closed" });
    if (change === "deleted") threads.delete(db, thread.id);
    release();
    await expect(polling).resolves.toBeUndefined();
    const fresh = threads.get(db, thread.id);
    if (change === "deleted") expect(fresh).toBeNull();
    else {
      expect(fresh?.doneAt).toBeNull();
      if (change === "replacement") expect(fresh).toMatchObject({ prUrl: "https://example.invalid/pull/replacement", prState: "closed" });
      appSettings.set({ autoDoneOnPrMerge: true });
      await lifecycle.tick();
      expect(threads.get(db, thread.id)?.doneAt).toBeNull();
    }
  });
});

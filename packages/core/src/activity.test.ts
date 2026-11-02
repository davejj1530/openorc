import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@openorc/cloud";
import { Db, teamRuntime } from "@openorc/db";
import { busyReason, fenceForUpdate, type BusyReason } from "./activity.js";
import { OpenOrc } from "./openorc.js";
import { RemoteTestClient } from "./remote/test-client.js";

const db = Db.memory();

function idle() {
  return {
    db,
    runs: { busy: false, backgroundCommandsRunning: false, prepareForUpdate: vi.fn(() => true) },
    threads: { deliveringQueued: false },
    cloud: { busy: false },
    memory: { hasPendingWork: false },
    textGeneration: { hasPendingWork: false },
    schedules: { hasPendingWork: false, stopAccepting: vi.fn() },
    claudeAccounts: { hasPendingWork: false },
    agentUpdates: { get: () => ({ updating: false }) },
    remote: { busy: false },
  };
}

type Sources = ReturnType<typeof idle>;

/** Each reason's own source, made busy on its own. */
const busySource: Record<BusyReason, (sources: Sources) => void> = {
  "agent-updates": (s) => void (s.agentUpdates.get = () => ({ updating: true })),
  memory: (s) => void (s.memory.hasPendingWork = true),
  teams: () => void vi.spyOn(teamRuntime, "openIds").mockReturnValue(["team"]),
  schedules: (s) => void (s.schedules.hasPendingWork = true),
  "background-commands": (s) => void (s.runs.backgroundCommandsRunning = true),
  agents: (s) => void (s.runs.busy = true),
  "queued-messages": (s) => void (s.threads.deliveringQueued = true),
  "cloud-sandboxes": (s) => void (s.cloud.busy = true),
  "text-generation": (s) => void (s.textGeneration.hasPendingWork = true),
  "claude-sign-in": (s) => void (s.claudeAccounts.hasPendingWork = true),
  phones: (s) => void (s.remote.busy = true),
};

const refusals: Record<BusyReason, RegExp | null> = {
  "agent-updates": /agent updates/,
  memory: /memory processing/,
  teams: /active teams/,
  schedules: /A schedule is starting a thread/,
  "background-commands": /background commands/,
  agents: /agent work, approvals, and context maintenance/,
  "queued-messages": null,
  "cloud-sandboxes": null,
  "text-generation": null,
  "claude-sign-in": null,
  phones: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the busy signal", () => {
  it("is null when nothing would be cut short", () => {
    expect(busyReason(idle())).toBeNull();
  });

  it.each(Object.keys(busySource) as BusyReason[])("names %s when only its source is busy", (reason) => {
    const sources = idle();
    busySource[reason](sources);
    expect(busyReason(sources)).toBe(reason);
  });

  it("names the first reason when several hold", () => {
    const sources = idle();
    busySource.phones(sources);
    busySource["background-commands"](sources);
    busySource.agents(sources);
    expect(busyReason(sources)).toBe("background-commands");
  });
});

describe("an update's fence", () => {
  it.each(Object.keys(refusals) as BusyReason[])("answers %s as updates always have", (reason) => {
    const sources = idle();
    busySource[reason](sources);
    const words = refusals[reason];
    if (words) {
      expect(fenceForUpdate(sources)).toMatch(words);
      expect(sources.runs.prepareForUpdate).not.toHaveBeenCalled();
      expect(sources.schedules.stopAccepting).not.toHaveBeenCalled();
    } else {
      expect(fenceForUpdate(sources)).toBeNull();
      expect(sources.runs.prepareForUpdate).toHaveBeenCalledOnce();
      expect(sources.schedules.stopAccepting).toHaveBeenCalledOnce();
    }
  });

  it("refuses with the agents' words, and keeps schedules running, when runs cannot be fenced", () => {
    const sources = idle();
    sources.runs.prepareForUpdate.mockReturnValue(false);
    expect(fenceForUpdate(sources)).toMatch(/agent work/);
    expect(sources.schedules.stopAccepting).not.toHaveBeenCalled();
  });
});

describe("a core's busy signal", () => {
  let dataDir: string;
  let core: OpenOrc;
  let phone: RemoteTestClient | null = null;

  afterEach(async () => {
    phone?.close();
    phone = null;
    await core.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function open(): Promise<OpenOrc> {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-activity-"));
    let secret: string | null = null;
    const remoteSecrets = { load: async () => secret, save: async (value: string) => void (secret = value) };
    const machine = { name: () => "Test host", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };
    core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push() {} }, remoteSecrets, remoteNetwork: { port: 0, machine } });
    return core;
  }

  it("reads a connected phone as busy until it leaves, and still lets an update go ahead", async () => {
    await open();
    await core.remote.attach((request) => core.handle(request));
    await core.remote.configure(true);
    expect(core.busy()).toBeNull();
    const paired = await RemoteTestClient.pair((await core.remote.beginPairing()).url, { name: "Phone" });
    if (typeof paired === "string") throw new Error(`refused: ${paired}`);
    phone = paired;
    await phone.call("projects.list", {});
    expect(core.busy()).toBe("phones");
    expect(core.prepareForUpdate()).toBeNull();
    phone.close();
    await vi.waitFor(() => expect(core.busy()).toBeNull());
  });

  it("reads a cloud sandbox held awake as busy until it is let go", async () => {
    await open();
    const sandbox = { awayMs: 200, keepAwake: async () => undefined, stop: async () => undefined } as unknown as Sandbox;
    const release = core.cloud.holdAwake("thread", sandbox);
    expect(core.busy()).toBe("cloud-sandboxes");
    expect(core.prepareForUpdate()).toBeNull();
    release();
    await vi.waitFor(() => expect(core.busy()).toBeNull());
  });
});

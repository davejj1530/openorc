import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainUnavailable,
  brainKeyText,
  newBrainKey,
  openHandover,
  type BrainAccess,
  type BrainControlRequest,
  type BrainControlResults,
  type BrainKey,
  type BrainMachineStatus,
  type BrainPhone,
  type ProjectBundle,
  type WakeInput,
  type WakeResult,
} from "@openorc/cloud";
import { Db, projects, threads } from "@openorc/db";
import { WORKSPACE_ID, type CloudService } from "@openorc/protocol";
import type { BrainDoors } from "./cloud-brain-door.js";
import { CloudBrain, type CloudBrainDeps } from "./cloud-brain.js";
import type { BrainMachineLike } from "./cloud-brain-machine.js";
import { BrainMove, MOVE_PHONES, type BrainThread } from "./cloud-brain-move.js";
import { NO_SIGN_INS } from "./cloud-brain-signins.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const VERCEL = { token: "vcp_move-fixture-token-0123456789", teamId: "team_move" };
const GITHUB = { token: "gho_move-fixture-token-0123456789", name: "Test", email: null };
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8", stdio: "pipe" }).trim();

/** What this Mac asked of each service and of its own moves, in order. */
let log: string[];
/** Points a test acts at, as when this Mac quits there. */
let hooks: {
  provision?: () => Promise<void>;
  doorRemoved?: () => Promise<void>;
  machineRemoved?: (service: CloudService) => Promise<void>;
  home?: (id: string) => Promise<void>;
  back?: (id: string) => Promise<void>;
  quiet?: () => void;
  /** Before each write of this Mac's brain record. */
  saving?: (value: string) => void;
};
/** The Agent37 key Settings connects. */
let agent37Key: string;

/** A brain's machine on one service, as the Mac sees it: it wakes with a key, takes handovers and project copies, and goes. */
class Machine implements BrainMachineLike {
  state: BrainMachineStatus["state"] = "missing";
  made = false;
  key: BrainKey | null = null;
  installed: string | null = null;
  /** How its brain answers a start, when not with a running brain. */
  fails: WakeResult | null = null;
  copies: BrainControlResults["projects"]["copies"] = [];
  phones: BrainPhone[] = [];
  /** The kinds of each handover it took. */
  handovers: string[][] = [];
  /** Until when it starts no new conversation, as the Mac last said. */
  leaving: number | null = null;

  constructor(
    private readonly service: CloudService,
    private readonly folder: () => string,
  ) {}

  private note(what: string): void {
    log.push(`${this.service} ${what}`);
  }

  async status() {
    return { state: this.state, address: this.made ? `${this.service}.fixture` : null, expiresAt: null };
  }
  async provision(bundle: { version: string }) {
    this.note("provision");
    await hooks.provision?.();
    if (this.state === "missing") this.state = "stopped";
    this.installed = bundle.version;
    return { installed: bundle.version, running: null };
  }
  async wake(input: WakeInput): Promise<WakeResult> {
    this.note("wake");
    if (this.fails) return this.fails;
    if (this.key && brainKeyText(this.key) !== brainKeyText(input.key)) return { state: "wrong-key" };
    this.key = input.key;
    this.state = "running";
    return { state: "ready", address: `${this.service}.fixture`, version: this.installed ?? "v1" };
  }
  async control(request: BrainControlRequest): Promise<never> {
    if (request.op === "leaving") this.note(`leaving ${request.until === null ? "off" : "on"}`);
    else if (request.op !== "sign-ins" && request.op !== "phones") this.note(request.op);
    if (this.state !== "running" || !this.key) throw new BrainUnavailable();
    switch (request.op) {
      case "handover": {
        const kinds = Object.keys(openHandover(this.key, request));
        this.handovers.push(kinds);
        return { applied: kinds } as never;
      }
      case "sign-ins":
        return { codex: null, github: null, push: null, memory: null, opencode: null, cloud: null } as never;
      case "projects":
        return { copies: this.copies } as never;
      case "copies-current":
        return { marked: request.copies.length } as never;
      case "project-settings":
        return { applied: true } as never;
      case "phones":
        return { phones: this.phones } as never;
      case "leaving":
        this.leaving = request.until;
        return { until: request.until } as never;
      default:
        throw new Error(`unexpected ${request.op}`);
    }
  }
  async importProject({ source, name, branch }: ProjectBundle) {
    this.note(`import ${name}`);
    if (this.state !== "running") throw new BrainUnavailable();
    const head = git(this.folder(), "rev-parse", branch);
    this.copies = [...this.copies.filter((copy) => copy.source !== source), { source, projectId: `${this.service}-${source}`, macHead: head, head, threads: 0 }];
    return { projectId: `${this.service}-${source}`, macHead: head, head };
  }
  async remove() {
    this.note("remove");
    this.state = "missing";
    this.made = false;
    this.key = null;
    this.copies = [];
    await hooks.machineRemoved?.(this.service);
  }
}

function memoryStore(saving?: (value: string) => void): ProtectedSecretStore & { value: () => string | null } {
  let saved: string | null = null;
  return {
    load: async () => saved,
    save: async (value) => {
      saving?.(value);
      saved = value;
    },
    value: () => saved,
  };
}

let root: string;
let folder: string;
let db: Db;
let machines: Record<CloudService, Machine>;
let main: ReturnType<typeof memoryStore>;
let beside: ReturnType<typeof memoryStore>;
let projectId: string;
/** The threads the old brain holds. */
let onBrain: BrainThread[];
/** Why a thread will not come to this Mac, or go back to the cloud; or a failure of the move itself. */
let stays: Map<string, string>;
let keeps: Map<string, string | Error>;
let swaps: (string | null)[];
/** Every access a brain was opened with. */
let opened: BrainAccess[];
let brain: CloudBrain;
let move: BrainMove;

const doors: BrainDoors = {
  open: async (_access, _opening, _bundle, options = {}) => {
    log.push("vercel door open");
    options.deploying?.();
    return { host: "door.fixture", mark: "mark", deployed: true };
  },
  close: async () => void log.push("vercel door close"),
  remove: async () => {
    log.push("vercel door remove");
    await hooks.doorRemoved?.();
  },
};

const agent37 = async () => ({ key: agent37Key, cpu: 2, memory: 4 }) as const;

function brainDeps(store: ProtectedSecretStore): CloudBrainDeps {
  return {
    db,
    store,
    tokens: { status: async () => ({}), token: async () => null },
    vercel: async () => VERCEL,
    agent37,
    service: async () => "vercel",
    signIns: { ...NO_SIGN_INS, github: async () => GITHUB },
    bundle: async () => ({ version: "v1", read: async () => Buffer.from("archive"), door: { release: "door-1", code: async () => Buffer.from("export {};") } }),
    changed: () => undefined,
    open: async (access, create) => {
      opened.push(access);
      const machine = machines[access.service];
      if (create) machine.made = true;
      return machine.made ? machine : null;
    },
    doors,
  };
}

/** This Mac's brain and its move, made again as at each start, over the same records, ledger and machines. */
function start(): void {
  brain = new CloudBrain(brainDeps(main));
  move = new BrainMove({
    db,
    brain,
    beside: (store, also) => new CloudBrain({ ...brainDeps(store), phonesKey: MOVE_PHONES, changed: () => also?.() }),
    store: beside,
    connections: { vercel: async () => VERCEL, agent37, service: async () => "vercel" },
    threads: async () => {
      log.push("list");
      return onBrain;
    },
    coordinator: {
      quiet: async () => {
        log.push("quiet");
        hooks.quiet?.();
      },
      bringHome: async (id) => {
        log.push(`home ${id}`);
        await hooks.home?.(id);
        const why = stays.get(id);
        if (why) return why;
        const thread = onBrain.find((each) => each.id === id)!;
        onBrain = onBrain.filter((each) => each.id !== id && each.parentRelation === null);
        threads.insert(db, { id, projectId, title: thread.title, agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
        return null;
      },
      sendBack: async (id) => {
        log.push(`back ${id}`);
        await hooks.back?.(id);
        const why = keeps.get(id);
        if (why instanceof Error) throw why;
        if (why) return why;
        threads.delete(db, id);
        return null;
      },
    },
    swapped: async (linkKey) => void swaps.push(linkKey),
    changed: () => undefined,
  });
}

/** Stops this Mac where a hook calls this, as quitting does. */
let quitted = false;
function quit(): never {
  quitted = true;
  move.close();
  throw new Error("This Mac closed before the move settled.");
}

/** A thread on the old brain, in its copy of the Mac project unless told otherwise. */
const thread = (id: string, title: string, extra: Partial<BrainThread> = {}): BrainThread => ({
  id,
  title,
  activity: "idle",
  parentRelation: null,
  projectId: `vercel-${projectId}`,
  agent: "claude",
  orclingId: null,
  worktreePath: `/brain/worktrees/${id}`,
  branch: `openorc/${id}`,
  ...extra,
});
type Record_ = { key: string; service?: string; moving?: { stage: string; threads: string[] }; projects?: { id: string; brainId: string | null }[] };
const record = () => JSON.parse(main.value() || "null") as Record_ | null;
const staged = () => JSON.parse(beside.value() || "null") as Record_ | null;
const ended = () => vi.waitFor(async () => expect((await move.status()).state).not.toBe("moving"), { timeout: 5000 });
const stopped = () => vi.waitFor(async () => expect(await move.status()).toMatchObject({ state: "moving", error: expect.any(String) }), { timeout: 5000 });
const at = (line: string) => log.indexOf(line);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-brain-move-"));
  folder = path.join(root, "app");
  execFileSync("mkdir", ["-p", folder]);
  git(folder, "init", "-q", "-b", "main");
  await writeFile(path.join(folder, "README.md"), "# app\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "first");
  db = Db.memory();
  projectId = projects.insert(db, { name: "app", rootPath: folder, gitRemote: null, defaultBranch: "main", settings: {} }).id;
  log = [];
  hooks = {};
  quitted = false;
  opened = [];
  agent37Key = "sk_live_move-fixture-key-0123456789";
  machines = { vercel: new Machine("vercel", () => folder), agent37: new Machine("agent37", () => folder) };
  main = memoryStore((value) => hooks.saving?.(value));
  beside = memoryStore();
  stays = new Map();
  keeps = new Map();
  swaps = [];
  start();
  // A brain on Vercel with the project's copy and GitHub, a phone paired, and two threads, one with a subagent's under it.
  await brain.create("fra1");
  await vi.waitFor(async () => expect((await brain.status()).state).toBe("ready"));
  await brain.setProject(projectId, true);
  await brain.setGitHub(true);
  await brain.rememberLinkKey("vercel-link");
  machines.vercel.phones = [{ id: "phone-1", name: "Pocket", createdAt: 1, lastSeenAt: 2, connected: false }];
  await vi.waitFor(() => expect(brain.phones.list()).toHaveLength(1));
  onBrain = [thread("t1", "Fix login"), thread("t1-sub", "Explore", { parentRelation: "subagent" }), thread("t2", "Write docs")];
  log = [];
});

afterEach(async () => {
  move.close();
  await rm(root, { recursive: true, force: true });
});

describe("moving the cloud brain to the other service", () => {
  it("brings its threads home, sets up the new brain with every sign-in and project, removes the old one door first, swaps, and sends the threads back", async () => {
    const oldKey = record()!.key;
    await move.start("agent37", undefined);
    await ended();

    // The subagent's thread moves with its parent, so it is never asked for alone.
    expect(log.filter((line) => /^(home|back) /.test(line))).toEqual(["home t1", "home t2", "back t1", "back t2"]);
    // The old brain starts no new conversation before each look at its threads.
    expect(at("vercel leaving on")).toBeLessThan(at("list"));
    expect(at("home t2")).toBeLessThan(at("agent37 provision"));
    expect(machines.agent37.handovers[0]).toEqual(expect.arrayContaining(["claude", "github", "cloud"]));
    expect(at("agent37 handover")).toBeLessThan(at("agent37 import app"));
    expect(at("agent37 import app")).toBeLessThan(at("quiet"));
    expect(at("quiet")).toBeLessThan(at("vercel door remove"));
    expect(at("vercel door remove")).toBeLessThan(at("vercel remove"));
    expect(at("vercel remove")).toBeLessThan(at("back t1"));

    const now = record()!;
    expect(now).toMatchObject({ service: "agent37", projects: [{ id: projectId, brainId: `agent37-${projectId}` }] });
    expect(now.key).not.toBe(oldKey);
    expect(brainKeyText(machines.agent37.key!)).toBe(now.key);
    expect(now).not.toHaveProperty("moving");
    expect(beside.value()).toBe("");
    expect([machines.vercel.made, machines.agent37.made]).toEqual([false, true]);
    expect(swaps).toEqual(["vercel-link"]);
    expect(threads.get(db, "t1")).toBeNull();
    // Paired phones knew the old brain only: none are listed, and Settings asks to pair again.
    expect(brain.phones.list()).toEqual([]);
    expect(await move.status()).toMatchObject({ state: "ready", service: "agent37", region: null, door: null, pairAgain: true, error: null });
    machines.agent37.phones = [{ id: "phone-2", name: "Pocket", createdAt: 3, lastSeenAt: 4, connected: false }];
    await brain.phones.ask();
    expect(await move.status()).not.toHaveProperty("pairAgain");
  });

  it("shows each step as it goes, with the threads moved so far", async () => {
    const seen: string[] = [];
    hooks.home = async () => {
      const shown = await move.status();
      if (shown.state === "moving") seen.push(`${shown.step} ${shown.threads?.done} of ${shown.threads?.of}`);
    };
    hooks.provision = async () => {
      const shown = await move.status();
      if (shown.state === "moving") seen.push(`${shown.step} ${shown.setup} to ${shown.to.service}`);
    };
    hooks.back = hooks.home;
    await move.start("agent37", undefined);
    await ended();
    expect(seen).toEqual(["home 0 of 2", "home 1 of 2", "setting-up machine to agent37", "back 0 of 2", "back 1 of 2"]);
  });

  it("brings home and sends back a thread started on the old brain while the new one set up", async () => {
    hooks.provision = async () => {
      hooks.provision = undefined;
      onBrain = [...onBrain, thread("t3", "Late start")];
    };
    await move.start("agent37", undefined);
    await ended();
    expect(log.filter((line) => /^(home|back) /.test(line))).toEqual(["home t1", "home t2", "home t3", "back t1", "back t2", "back t3"]);
    expect(at("home t3")).toBeLessThan(at("vercel remove"));
    expect(threads.get(db, "t3")).toBeNull();
  });

  it("asks the old brain once more just before removing it, as its phones may have started a thread while this Mac was off", async () => {
    hooks.quiet = () => {
      hooks.quiet = undefined;
      onBrain = [...onBrain, thread("t4", "From the phone")];
    };
    await move.start("agent37", undefined);
    await ended();
    expect(at("home t4")).toBeGreaterThan(at("quiet"));
    expect(at("home t4")).toBeLessThan(at("vercel remove"));
    expect(log.filter((line) => line.startsWith("back "))).toEqual(["back t1", "back t2", "back t4"]);
  });

  it("refuses in words while a thread on the brain is at work, moving nothing, and lets the brain start conversations again", async () => {
    onBrain[2] = thread("t2", "Write docs", { activity: "running" });
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({ state: "ready", service: "vercel", note: "Didn't move to Agent37. A thread is still working on the cloud brain. Try again once it's done." });
    expect(log.filter((line) => /leaving|^list|^home /.test(line))).toEqual(["vercel leaving on", "list", "vercel leaving off"]);
    expect(log.some((line) => line.startsWith("agent37"))).toBe(false);
    expect(machines.vercel.leaving).toBeNull();
    expect(record()).not.toHaveProperty("moving");
  });

  it("refuses before moving any thread when one can never leave the brain", async () => {
    onBrain = [thread("t1", "Fix login"), thread("w1", "Notes", { projectId: WORKSPACE_ID })];
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({ note: "Didn't move to Agent37. “Notes” can't leave the cloud brain. Only a project's conversations can move." });
    onBrain = [thread("t1", "Fix login"), thread("o1", "Elsewhere", { projectId: "vercel-unknown" })];
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({ note: "Didn't move to Agent37. “Elsewhere” can't leave the cloud brain. This conversation's project has no copy on the Mac." });
    expect(log.some((line) => line.startsWith("home "))).toBe(false);
  });

  it("stops at the first thread that will not come home: those home stay, the rest stay on the old brain, which keeps running", async () => {
    stays.set("t2", "Its agent is at work. Stop the turn, then move it.");
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({
      state: "ready",
      service: "vercel",
      note: "Didn't move to Agent37. “Write docs” stayed on the cloud brain. Its agent is at work. Stop the turn, then move it. The conversation brought here stays on this Mac.",
    });
    expect(threads.get(db, "t1")).not.toBeNull();
    expect(log.some((line) => line.startsWith("agent37"))).toBe(false);
    expect(machines.vercel.made).toBe(true);
    expect(record()).not.toHaveProperty("moving");
  });

  it("keeps what a move left to say past the brain's next operation, without the token it carried, until dismissed or the next move", async () => {
    stays.set("t1", `Vercel refused ${VERCEL.token}.`);
    await move.start("agent37", undefined);
    await ended();
    const note = "Didn't move to Agent37. “Fix login” stayed on the cloud brain. Vercel refused [redacted].";
    expect(await move.status()).toMatchObject({ note });
    await brain.wake();
    expect(await move.status()).toMatchObject({ note, error: null });
    move.dismiss();
    expect(await move.status()).not.toHaveProperty("note");
  });

  it("removes the new brain when it does not get ready, keeping the old one as it was, and says so of the new one", async () => {
    const before = record()!.key;
    machines.agent37.fails = { state: "failed", detail: "Exited." };
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({
      state: "ready",
      service: "vercel",
      note: "Didn't move to Agent37. The new brain on Agent37 didn't set up. The cloud brain did not start. Exited. The 2 conversations brought here stay on this Mac.",
    });
    expect(log).toContain("agent37 remove");
    expect(machines.agent37.made).toBe(false);
    expect(beside.value()).toBe("");
    expect(record()).toMatchObject({ key: before, service: "vercel" });
    expect(log).not.toContain("vercel remove");
  });

  it("never removes a brain the other service has that this Mac has no key for", async () => {
    machines.agent37.made = true;
    machines.agent37.state = "stopped";
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({ state: "ready", service: "vercel", note: expect.stringContaining("Your Agent37 account already has a cloud brain this Mac has no key for.") });
    expect(log).not.toContain("agent37 remove");
    expect(machines.agent37.made).toBe(true);
  });

  describe("a new brain's record left by an earlier move", () => {
    const leftover = (place: object, ready: boolean) => beside.save(JSON.stringify({ key: brainKeyText(newBrainKey()), ...place, address: ready ? "x.fixture" : null, ready, claude: [] }));

    it("on the service this brain runs on, is dropped without touching what that service has, which is this brain", async () => {
      await leftover({ service: "vercel", teamId: VERCEL.teamId, region: "fra1" }, true);
      await move.start("agent37", undefined);
      await ended();
      expect(log.filter((line) => line === "vercel remove")).toHaveLength(1);
      expect(at("vercel remove")).toBeGreaterThan(at("agent37 import app"));
      expect(await move.status()).toMatchObject({ state: "ready", service: "agent37" });
      expect(await move.status()).not.toHaveProperty("note");
    });

    it("never ready, is dropped, and a brain its key may not open is found as one this Mac has no key for, not removed", async () => {
      await leftover({ service: "agent37" }, false);
      machines.agent37.made = true;
      machines.agent37.state = "stopped";
      await move.start("agent37", undefined);
      await ended();
      expect(await move.status()).toMatchObject({ state: "ready", service: "vercel", note: expect.stringContaining("Your Agent37 account already has a cloud brain this Mac has no key for.") });
      expect(log).not.toContain("agent37 remove");
      expect(machines.agent37.made).toBe(true);
      expect(beside.value()).toBe("");
    });
  });

  it("reaches a brain on Agent37 only with the key of the account it was made in", async () => {
    await move.start("agent37", undefined);
    await ended();
    agent37Key = "sk_live_another-account-key-0123456789";
    opened = [];
    expect(await move.status()).toMatchObject({ error: expect.stringContaining("The cloud brain is on another Agent37 account. Connect that account's key.") });
    await brain.wake();
    expect(opened).toEqual([]);
  });

  it("keeps the old brain's door gone: nothing the brain does meanwhile opens it again between its removal and the swap", async () => {
    hooks.doorRemoved = async () => brain.cloudChanged();
    await move.start("agent37", undefined);
    await ended();
    expect(log.slice(at("vercel door remove"))).not.toContain("vercel door open");
    expect(await move.status()).toMatchObject({ state: "ready", service: "agent37", door: null, error: null });
  });

  it("stops where it is when the old brain cannot be removed, and goes on when asked", async () => {
    hooks.doorRemoved = async () => {
      throw new Error("Vercel answered 500.");
    };
    await move.start("agent37", undefined);
    await stopped();
    expect(await move.status()).toMatchObject({ state: "moving", step: "removing", error: "Could not remove the cloud brain's door. Vercel answered 500." });
    expect(record()).toMatchObject({ service: "vercel", moving: { stage: "swapping" } });
    expect(machines.vercel.made).toBe(true);
    hooks.doorRemoved = undefined;
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({ state: "ready", service: "agent37", error: null });
    expect(threads.get(db, "t1")).toBeNull();
  });

  it("calls off a move stopped before the old brain went: the new one goes, the old one stays and opens its door again", async () => {
    hooks.doorRemoved = async () => {
      throw new Error("Vercel answered 500.");
    };
    await move.start("agent37", undefined);
    await stopped();
    hooks.doorRemoved = undefined;
    log = [];
    await move.cancel();
    expect(log).toEqual(expect.arrayContaining(["agent37 remove", "vercel leaving off"]));
    await vi.waitFor(() => expect(log).toContain("vercel door open"));
    expect([machines.vercel.made, machines.agent37.made]).toEqual([true, false]);
    expect(beside.value()).toBe("");
    expect(record()).toMatchObject({ service: "vercel" });
    expect(record()).not.toHaveProperty("moving");
    expect(await move.status()).toMatchObject({ state: "ready", service: "vercel" });
  });

  it("calls off a move stopped while sending threads back: the rest stay on this Mac, the new brain kept", async () => {
    keeps.set("t1", new Error("The package could not be written."));
    await move.start("agent37", undefined);
    await stopped();
    expect(await move.status()).toMatchObject({ step: "back", error: "The package could not be written." });
    await move.cancel();
    expect(await move.status()).toMatchObject({ state: "ready", service: "agent37" });
    expect(record()).not.toHaveProperty("moving");
    expect([threads.get(db, "t1"), threads.get(db, "t2")].map((row) => row?.id)).toEqual(["t1", "t2"]);
  });

  it("keeps a thread that will not go back on this Mac, saying why, and finishes the move", async () => {
    keeps.set("t2", "The cloud brain doesn't have this project's copy yet. Try again once it's sent.");
    await move.start("agent37", undefined);
    await ended();
    expect(await move.status()).toMatchObject({
      state: "ready",
      service: "agent37",
      note: "“Write docs” stayed on this Mac. The cloud brain doesn't have this project's copy yet. Try again once it's sent.",
    });
    expect(threads.get(db, "t2")).not.toBeNull();
    expect(threads.get(db, "t1")).toBeNull();
  });

  it("stops, rather than starting over, when the move's record cannot be cleared", async () => {
    onBrain[2] = thread("t2", "Write docs", { activity: "running" });
    hooks.saving = (value) => {
      if (!(JSON.parse(value) as Record_).moving) throw new Error("locked");
    };
    await move.start("agent37", undefined);
    await stopped();
    expect(log.filter((line) => line === "list")).toHaveLength(1);
    expect(record()).toMatchObject({ moving: { stage: "home" } });
    expect(await move.status()).toMatchObject({ step: "home", error: expect.stringContaining("Cannot access protected storage for the cloud brain.") });
  });

  it("shows a move this Mac quit during as soon as it starts again, and holds Remove, setup and new cloud threads back meanwhile", async () => {
    await main.save(JSON.stringify({ ...record(), moving: { to: { service: "agent37", region: null }, stage: "home", threads: [] } }));
    start();
    expect(await move.status()).toMatchObject({ state: "moving", service: "vercel", to: { service: "agent37" }, step: "home" });
    expect([await move.busy(), await move.holding()]).toEqual([true, true]);
  });

  it("holds new threads back from the leaving brain until the new one takes over", async () => {
    const holding: boolean[] = [];
    hooks.home = async () => void holding.push(await move.holding());
    hooks.back = hooks.home;
    await move.start("agent37", undefined);
    await ended();
    expect(holding).toEqual([true, true, false, false]);
    expect(await move.holding()).toBe(false);
  });

  describe("after this Mac quits mid-move, at its next start", () => {
    const stops: [string, () => void][] = [
      ["bringing threads home", () => (hooks.home = async (id) => (id === "t2" ? quit() : undefined))],
      ["setting up the new brain", () => (hooks.provision = async () => quit())],
      ["removing the old brain's door", () => (hooks.doorRemoved = async () => quit())],
      [
        "between the old machine's removal and the swap's write",
        () =>
          (hooks.saving = (value) => {
            if ((JSON.parse(value) as Record_).moving?.stage === "back") quit();
          }),
      ],
      ["sending threads back", () => (hooks.back = async (id) => (id === "t2" ? quit() : undefined))],
    ];
    for (const [where, stop] of stops)
      it(`finishes a move stopped while ${where}, with one new brain and every thread back`, async () => {
        stop();
        await move.start("agent37", undefined);
        await vi.waitFor(() => expect(quitted).toBe(true));
        // What the quitting Mac was doing unwinds, as its process would end.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const kept = staged()?.key;
        hooks = {};
        start();
        move.resume();
        await vi.waitFor(() => expect(record()).not.toHaveProperty("moving"), { timeout: 5000 });
        await ended();
        const now = record()!;
        expect(now).toMatchObject({ service: "agent37" });
        if (kept) expect(now.key).toBe(kept);
        expect([machines.vercel.made, machines.agent37.made]).toEqual([false, true]);
        expect([threads.get(db, "t1"), threads.get(db, "t2")]).toEqual([null, null]);
        expect(await move.status()).toMatchObject({ state: "ready", service: "agent37", error: null });
        expect(swaps).toEqual(["vercel-link"]);
      });
  });
});

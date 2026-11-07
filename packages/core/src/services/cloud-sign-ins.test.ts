import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeAccounts, Db } from "@openorc/db";
import type { ClaudeCloudAccess, CloudBrainSignIns, CodexCloudAccess } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudSignInsFlow } from "./cloud-sign-ins.js";
import { macSignIns } from "./mac-agent-keys.js";

const MAC_CODEX_KEY = "sk-mac-codex-fixture-0123456789";
const MAC_OPENROUTER_KEY = "sk-or-mac-fixture-0123456789";

/** The person's browser: each sign-in opens there and finishes when they approve it, at once unless held. */
class Browser {
  readonly opened: string[] = [];
  readonly events: string[] = [];
  open = 0;
  most = 0;
  hold = false;
  private readonly waiting = new Map<string, () => void>();

  signIn(name: string, approved: () => void): Promise<void> {
    this.opened.push(name);
    this.events.push(`browser ${name}`);
    this.open += 1;
    this.most = Math.max(this.most, this.open);
    const done = new Promise<void>((resolve) =>
      this.waiting.set(name, () => {
        this.open -= 1;
        approved();
        resolve();
      }),
    );
    if (!this.hold) queueMicrotask(() => this.approve(name));
    return done;
  }

  approve(name: string): void {
    const finish = this.waiting.get(name);
    this.waiting.delete(name);
    finish?.();
  }
}

let root: string;
let db: Db;
let browser: Browser;
let work: string;

/** The services that keep each sign-in, as the flow sees them. */
function services(brainSetUp: boolean) {
  const tokens = {
    saved: new Set<string>(),
    pending: new Map<string, Promise<void>>(),
    async status(): Promise<Record<string, ClaudeCloudAccess>> {
      const ids = new Set([...this.saved, ...this.pending.keys()]);
      return Object.fromEntries([...ids].map((id) => [id, { createdAt: this.saved.has(id) ? 1 : null, creating: this.pending.has(id), error: null }]));
    },
    async create(id: string) {
      this.pending.set(
        id,
        browser.signIn(`claude:${id}`, () => {
          this.pending.delete(id);
          this.saved.add(id);
        }),
      );
    },
    finished(id: string) {
      return this.pending.get(id) ?? Promise.resolve();
    },
  };
  const codex = {
    mode: null as CodexCloudAccess["mode"],
    key: null as string | null,
    signing: null as Promise<void> | null,
    async status(): Promise<CodexCloudAccess> {
      return { mode: this.mode, email: null, plan: null, refreshedAt: null, signingIn: this.signing !== null, error: null };
    },
    async signIn() {
      this.signing = browser.signIn("codex", () => {
        this.signing = null;
        this.mode = "chatgpt";
      });
    },
    finished() {
      return this.signing ?? Promise.resolve();
    },
    async saveApiKey(key: string) {
      browser.events.push("copy codex");
      this.mode = "apiKey";
      this.key = key;
    },
  };
  const opencode = {
    keys: new Map<string, string>(),
    async providers() {
      return [...this.keys.keys()].sort();
    },
    async save(provider: string, key: string) {
      browser.events.push(`copy opencode:${provider}`);
      this.keys.set(provider, key);
    },
  };
  const brain = {
    codex: null as CloudBrainSignIns["codex"]["mode"],
    codexKey: null as string | null,
    github: false,
    handovers: 0,
    async exists() {
      return brainSetUp;
    },
    async moves() {
      return brainSetUp ? ({ address: "brain.fixture", projects: [] } as never) : null;
    },
    async signIns(): Promise<CloudBrainSignIns> {
      return {
        codex: { mode: this.codex, email: null, plan: null, signingIn: false, pending: null, error: null },
        github: { on: this.github, blocked: null, behind: false },
        push: { has: false, behind: false },
        memory: { has: false, behind: false },
      };
    },
    codexSignIn() {
      void browser.signIn("brain-codex", () => (this.codex = "chatgpt"));
    },
    async codexFinished() {},
    codexApiKey(key: string) {
      browser.events.push("copy brain-codex");
      this.codex = "apiKey";
      this.codexKey = key;
    },
    async setGitHub(on: boolean) {
      browser.events.push("copy github");
      this.github = on;
    },
    async handover() {
      browser.events.push("handover");
      this.handovers += 1;
    },
  };
  return { tokens, codex, opencode, brain };
}

function flowWith(parts: ReturnType<typeof services>) {
  const env = { HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "codex"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state") };
  const mac = macSignIns(() => ({ env, binaries: { claude: null, codex: "/fixture/codex", opencode: "/fixture/opencode" } }));
  return new CloudSignInsFlow({ db, ...parts, mac, changed: () => undefined });
}

async function settled(flow: CloudSignInsFlow) {
  await vi.waitFor(async () => expect((await flow.status()).bringing).toBe(false));
  return flow.status();
}

async function macKeys(): Promise<void> {
  await mkdir(path.join(root, "codex"), { recursive: true });
  await writeFile(path.join(root, "codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: MAC_CODEX_KEY }));
  await mkdir(path.join(root, "data", "opencode"), { recursive: true });
  const auth = { openrouter: { type: "api", key: MAC_OPENROUTER_KEY }, anthropic: { type: "oauth", refresh: "r", access: "a", expires: 0 } };
  await writeFile(path.join(root, "data", "opencode", "auth.json"), JSON.stringify(auth));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-sign-ins-"));
  db = Db.open(path.join(root, "ledger.sqlite"));
  work = claudeAccounts.add(db, "Work").id;
  browser = new Browser();
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

it("copies this Mac's Codex and OpenCode keys and asks the browser only for the rest, one at a time", async () => {
  await macKeys();
  const parts = services(false);
  const flow = flowWith(parts);
  expect((await flow.status()).rows.map(({ label, state, way }) => ({ label, state, way }))).toEqual([
    { label: claudeAccounts.get(db, claudeAccounts.defaultId(db)).name, state: "missing", way: "browser" },
    { label: "Work", state: "missing", way: "private-window" },
    { label: "Codex", state: "missing", way: "copy" },
    { label: "Anthropic", state: "missing", way: "key" },
    { label: "OpenRouter", state: "missing", way: "copy" },
  ]);
  flow.bringAll(true);
  const after = await settled(flow);
  expect(browser.events).toEqual(["copy codex", "copy opencode:openrouter", `browser claude:${claudeAccounts.defaultId(db)}`, `browser claude:${work}`]);
  expect(browser.most).toBe(1);
  expect(parts.codex.key).toBe(MAC_CODEX_KEY);
  expect(parts.opencode.keys).toEqual(new Map([["openrouter", MAC_OPENROUTER_KEY]]));
  expect(after.rows.filter((row) => row.state !== "ready").map((row) => row.label)).toEqual(["Anthropic"]);
  expect(parts.brain.handovers).toBe(0);
});

it("does nothing when run again", async () => {
  await macKeys();
  const flow = flowWith(services(false));
  flow.bringAll(true);
  await settled(flow);
  const before = [...browser.events];
  flow.bringAll(true);
  await settled(flow);
  expect(browser.events).toEqual(before);
});

it("copies nothing without the person's yes", async () => {
  await macKeys();
  const parts = services(false);
  const flow = flowWith(parts);
  flow.bringAll(false);
  await settled(flow);
  expect(browser.events).toEqual([`browser claude:${claudeAccounts.defaultId(db)}`, `browser claude:${work}`]);
  expect(parts.codex.key).toBeNull();
  expect(parts.opencode.keys.size).toBe(0);
});

it("stops after the sign-in under way when cancelled", async () => {
  browser.hold = true;
  const flow = flowWith(services(false));
  flow.bringAll(true);
  const first = `claude:${claudeAccounts.defaultId(db)}`;
  await vi.waitFor(() => expect(browser.opened).toEqual([first]));
  expect((await flow.status()).rows[0]).toMatchObject({ state: "working" });
  flow.cancel();
  browser.approve(first);
  const after = await settled(flow);
  expect(browser.opened).toEqual([first]);
  expect(after.rows.map((row) => row.state)).toEqual(["ready", "missing", "missing"]);
});

it("hands everything to the cloud brain at the end", async () => {
  await macKeys();
  const parts = services(true);
  const flow = flowWith(parts);
  expect((await flow.status()).rows.map((row) => row.label)).toContain("Codex on the cloud brain");
  flow.bringAll(true);
  await settled(flow);
  expect(parts.brain.codexKey).toBe(MAC_CODEX_KEY);
  expect(parts.brain.github).toBe(true);
  expect(browser.events.at(-1)).toBe("handover");
  expect(parts.brain.handovers).toBe(1);
});

it("brings the one sign-in asked for, and nothing else", async () => {
  const flow = flowWith(services(false));
  flow.bring({ kind: "claude", accountId: work });
  const after = await settled(flow);
  expect(browser.opened).toEqual([`claude:${work}`]);
  expect(after.rows.find((row) => row.kind === "claude" && row.accountId === work)?.state).toBe("ready");
});

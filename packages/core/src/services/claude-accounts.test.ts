import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHARED_CLAUDE_CONFIG_DIR } from "@openorc/agents";
import { claudeAccounts, Db } from "@openorc/db";
import { ClaudeAccountService } from "./claude-accounts.js";
import type { EnvSnapshot } from "./shell-environment.js";

let root: string;
let db: Db;
let service: ClaudeAccountService;
let snapshot: EnvSnapshot;
const busy = vi.fn(() => false);
const fake = vi.hoisted(() => ({ chrome: null as string | null }));
vi.mock("@openorc/agents/chrome-incognito", async (original) => ({ ...(await original<typeof import("@openorc/agents/chrome-incognito")>()), chromeExecutable: () => fake.chrome }));
const changed = vi.fn();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-accounts-"));
  const binary = path.join(root, "fixture-claude");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CLAUDE_CONFIG_DIR;
if (process.argv.includes('login')) {
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ dir, home: process.env.HOME, apiKey: process.env.ANTHROPIC_API_KEY, browser: process.env.BROWSER, args: process.argv.slice(2) }));
  if (process.env.BROWSER) require('node:child_process').execFileSync(process.env.BROWSER, ['http://localhost:1/callback?code=a&state=$(nope)']);
  if (process.env.FIXTURE_HOLD) setInterval(() => {}, 1000);
  else setTimeout(() => { fs.writeFileSync(path.join(dir, 'connected'), 'fixture'); }, 100);
} else {
  console.log(JSON.stringify({ loggedIn: fs.existsSync(path.join(dir, 'connected')), email: path.basename(dir) + '@example.test', orgName: 'Fixture' }));
}
`,
    { mode: 0o700 },
  );
  db = Db.open(path.join(root, "accounts.sqlite"));
  snapshot = {
    revision: 1,
    shell: "/bin/sh",
    path: process.env.PATH ?? "",
    binaries: { claude: binary, codex: null, opencode: null },
    env: Object.freeze({
      HOME: root,
      PATH: process.env.PATH ?? "",
      CLAUDE_CONFIG_DIR: path.join(root, "original"),
      ANTHROPIC_API_KEY: "fixture-only",
      ANTHROPIC_BASE_URL: "https://fixture.invalid",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-only",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    }),
  };
  fake.chrome = null;
  busy.mockReset().mockReturnValue(false);
  changed.mockReset();
  service = new ClaudeAccountService(db, root, () => snapshot, changed, busy);
});
afterEach(async () => {
  await service.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

it("isolates three managed accounts while preserving the existing CLI environment", () => {
  const accounts = ["Work", "Personal", "Client"].map((name) => service.add(name));
  const environments = accounts.map(({ id }) => service.environment(snapshot, id));
  expect(new Set(environments.map((entry) => entry.env.CLAUDE_CONFIG_DIR)).size).toBe(3);
  for (const env of environments) {
    expect(env.env.HOME).toBe(root);
    expect(env.env.CLAUDE_CODE_DISABLE_FAST_MODE).toBe("1");
    expect(env.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  }
  expect(service.environment(snapshot, "claude-cli").env).toEqual(snapshot.env);
  expect(snapshot.env.ANTHROPIC_API_KEY).toBe("fixture-only");
  expect(() => service.environment(snapshot, "../../other")).toThrow(/no longer available/);
});

it("links the CLI login's personal skills into a signed-in added account and drops them once uninstalled", async () => {
  const original = path.join(root, "original", "skills");
  for (const name of ["humanizer", "research", "synced/bucket/morning", ".hidden"]) await mkdir(path.join(original, name), { recursive: true });
  const account = service.add("Work");
  expect(service.environment(snapshot, account.id).env[SHARED_CLAUDE_CONFIG_DIR]).toBe(path.join(root, "original"));
  // Not signed in yet: the folder keeps the private mode sign-in creates it with.
  const directory = path.join(root, "claude-accounts", account.id);
  await expect(stat(directory)).rejects.toThrow();
  await mkdir(path.join(directory, "skills", "synced", "own-bucket"), { recursive: true });
  await mkdir(path.join(directory, "skills", "research"));
  service.environment(snapshot, account.id);
  const skills = path.join(directory, "skills");
  expect((await readdir(skills)).sort()).toEqual(["humanizer", "research", "synced"]);
  expect(await readlink(path.join(skills, "humanizer"))).toBe(path.join(original, "humanizer"));
  expect((await lstat(path.join(skills, "research"))).isSymbolicLink()).toBe(false);
  await rm(path.join(original, "humanizer"), { recursive: true });
  service.environment(snapshot, account.id);
  expect((await readdir(skills)).sort()).toEqual(["research", "synced"]);
  expect(service.environment(snapshot, "claude-cli").env[SHARED_CLAUDE_CONFIG_DIR]).toBeUndefined();
});

it("keeps an added account's memory with the CLI login's and moves in what the account saved alone", async () => {
  const account = service.add("Work");
  const original = path.join(root, "original");
  expect(service.environment(snapshot, account.id).env.CLAUDE_CODE_REMOTE_MEMORY_DIR).toBe(original);
  expect(service.environment(snapshot, "claude-cli").env.CLAUDE_CODE_REMOTE_MEMORY_DIR).toBeUndefined();
  const own = (project: string) => path.join(root, "claude-accounts", account.id, "projects", project, "memory");
  const shared = (project: string) => path.join(original, "projects", project, "memory");
  await mkdir(own("-repo"), { recursive: true });
  await mkdir(shared("-repo"), { recursive: true });
  await mkdir(own("-empty"), { recursive: true });
  await mkdir(own("-solo"), { recursive: true });
  await writeFile(path.join(shared("-repo"), "MEMORY.md"), "- [Tabs](tabs.md) — tabs\n- [Lint](lint.md) — lint");
  await writeFile(path.join(shared("-repo"), "tabs.md"), "use tabs");
  await writeFile(path.join(shared("-repo"), "lint.md"), "run lint");
  await writeFile(path.join(own("-repo"), "MEMORY.md"), "- [Tabs](tabs.md) — tabs\n- [Ports](ports.md) — ports\n- [Lint](lint.md) — lint\n");
  await writeFile(path.join(own("-repo"), "ports.md"), "port 80");
  await writeFile(path.join(own("-repo"), "lint.md"), "run lint");
  await writeFile(path.join(own("-repo"), "tabs.md"), "use spaces");
  await writeFile(path.join(own("-solo"), "MEMORY.md"), "- [Solo](solo.md) — solo\n");
  await writeFile(path.join(own("-solo"), "solo.md"), "solo");

  service.environment(snapshot, account.id);
  service.environment(snapshot, account.id);

  expect(await readFile(path.join(shared("-repo"), "MEMORY.md"), "utf8")).toBe("- [Tabs](tabs.md) — tabs\n- [Lint](lint.md) — lint\n- [Ports](ports.md) — ports\n");
  expect(await readFile(path.join(shared("-repo"), "ports.md"), "utf8")).toBe("port 80");
  expect(await readFile(path.join(shared("-repo"), "tabs.md"), "utf8")).toBe("use tabs");
  expect(await readdir(own("-repo"))).toEqual(["tabs.md"]);
  expect((await readdir(shared("-solo"))).sort()).toEqual(["MEMORY.md", "solo.md"]);
  await expect(stat(own("-solo"))).rejects.toThrow();
  await expect(stat(own("-empty"))).rejects.toThrow();
  await expect(stat(shared("-empty"))).rejects.toThrow();
});

it("signs in through the selected CLI directory and reports only public account metadata", async () => {
  const account = service.add("Work");
  const directory = service.environment(snapshot, account.id).env.CLAUDE_CONFIG_DIR!;
  expect(await service.login(account.id)).toEqual({ started: true });
  expect(await service.login(account.id)).toEqual({ started: false });
  expect(() => service.environment(snapshot, account.id)).toThrow(/Finish signing in/);
  await vi.waitFor(() => expect(service.hasPendingWork).toBe(false));
  const launch = JSON.parse(await readFile(path.join(directory, "launch.json"), "utf8"));
  expect(launch).toMatchObject({ dir: directory, home: root, args: ["--setting-sources", "user", "auth", "login", "--claudeai"] });
  expect(launch.apiKey).toBeUndefined();
  if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const result = await service.list();
  expect(result.accounts.find((entry) => entry.id === account.id)).toMatchObject({ status: "ready", email: `${account.id}@example.test`, organization: "Fixture" });
  expect(JSON.stringify(result)).not.toContain("fixture-only");
  expect(JSON.stringify(db.stmt("SELECT * FROM claude_accounts").all())).not.toContain("fixture-only");
});

it("signs added accounts in from Chrome Incognito and keeps the existing login on the default browser", async () => {
  const log = path.join(root, "chrome.log");
  fake.chrome = path.join(root, "fixture-chrome");
  await writeFile(fake.chrome, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  const signIn = async (id: string) => {
    await service.login(id);
    await vi.waitFor(() => expect(service.hasPendingWork).toBe(false), { timeout: 5000 });
    return JSON.parse(await readFile(path.join(service.environment(snapshot, id).env.CLAUDE_CONFIG_DIR!, "launch.json"), "utf8"));
  };
  const opened = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  await signIn(service.add("Work").id);
  expect(await opened()).toEqual([["--incognito", "--new-window", "http://localhost:1/callback?code=a&state=$(nope)"]]);
  expect((await signIn("claude-cli")).browser).toBeUndefined();
  fake.chrome = null;
  expect((await signIn(service.add("Personal").id)).browser).toBeUndefined();
  expect(await opened()).toHaveLength(1);
});

it("persists arbitrary account names and defaults, rejects disabled accounts without a fallback", async () => {
  const account = service.add("Work");
  service.add("Personal");
  service.add("Client");
  service.update({ id: account.id, name: "Company", makeDefault: true });
  expect(() => service.update({ id: account.id, enabled: false })).toThrow(/another default/);
  await service.close();
  db.close();
  db = Db.open(path.join(root, "accounts.sqlite"));
  service = new ClaudeAccountService(db, root, () => snapshot, changed, busy);
  expect(service.defaultId()).toBe(account.id);
  expect(claudeAccounts.list(db).map((entry) => entry.name)).toContain("Company");
  service.update({ id: "claude-cli", makeDefault: true });
  service.update({ id: account.id, enabled: false });
  expect(() => service.environment(snapshot, account.id)).toThrow(/disabled/);
  expect(service.inspectionEnvironment(snapshot, account.id).binaries.claude).toBeNull();
  await expect(service.login(account.id)).rejects.toThrow(/disabled/);
  service.update({ id: account.id, enabled: true });
  expect(service.environment(snapshot, account.id).claudeAccountId).toBe(account.id);
});

it("cancels a pending login and changes cache scope after an explicit refresh", async () => {
  snapshot = { ...snapshot, env: { ...snapshot.env, FIXTURE_HOLD: "1" } };
  const account = service.add("Work");
  const before = service.environment(snapshot, account.id).scope;
  await service.login(account.id);
  expect((await service.list()).accounts.find((entry) => entry.id === account.id)?.status).toBe("signing_in");
  expect(() => service.update({ id: account.id, enabled: false })).toThrow(/active sessions/);
  expect(service.cancelLogin(account.id)).toEqual({ cancelled: true });
  await vi.waitFor(() => expect(service.hasPendingWork).toBe(false));
  const finished = service.environment(snapshot, account.id).scope;
  expect(finished).not.toBe(before);
  await service.list(true);
  expect(service.environment(snapshot, account.id).scope).not.toBe(finished);
  busy.mockReturnValue(true);
  await expect(service.login(account.id)).rejects.toThrow(/active sessions/);
});

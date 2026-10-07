import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { claudeAccounts, Db } from "@openorc/db";
import { ClaudeAccountService } from "./claude-accounts.js";
import type { EnvSnapshot } from "./shell-environment.js";

let root: string;
let db: Db;
let service: ClaudeAccountService;
let snapshot: EnvSnapshot;
const busy = vi.fn(() => false);
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
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ dir, home: process.env.HOME, apiKey: process.env.ANTHROPIC_API_KEY, args: process.argv.slice(2) }));
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

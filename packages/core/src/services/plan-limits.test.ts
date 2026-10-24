import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeAccounts, Db } from "@openorc/db";
import type { ClaudeUsageResult } from "@openorc/agents";
import type { HarnessAvailability, HarnessId, SystemInfo } from "@openorc/protocol";
import { PLAN_LIMITS_MAX_AGE_MS, readPlanLimits } from "./plan-limits.js";
import { ProviderUsageService } from "./provider-usage.js";
import type { EnvSnapshot } from "./shell-environment.js";

const start = 1_800_000_000_000;
const minute = 60_000;
const installed: SystemInfo = {
  dataDir: "/Users/me/Library/Application Support/OpenOrc",
  harnesses: [
    { id: "codex", state: "ready", path: "/Users/me/.local/bin/codex", version: "1.0.0", revision: 0 },
    { id: "claude", state: "ready", path: "/Users/me/.local/bin/claude", version: "1.0.0", revision: 0 },
    { id: "opencode", state: "not_found", path: null, version: null, revision: 0 },
  ],
  gh: { installed: false, path: null },
};

/** What the CLIs tell the Mac, as their own answers carry it: the Codex account's email, a reset token, Claude's own words. */
const codexAnswer = {
  account: { type: "chatgpt", planType: "pro", email: "me@example.com" },
  limits: {
    rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_010_000 }, secondary: { usedPercent: 46, windowDurationMins: 10_080, resetsAt: 1_800_400_000 } },
    rateLimitResetCredits: { availableCount: 1 },
  },
};
const claudeAnswer: ClaudeUsageResult = {
  status: "ok",
  subscriptionType: "max",
  usage: {
    limits: [
      { kind: "session", group: "session", percent: 38, resets_at: "2027-01-15T20:30:00Z" },
      { kind: "weekly_all", group: "weekly", percent: 71, resets_at: "2027-01-19T23:00:00Z" },
    ],
  },
};

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** The Mac's shell environment at a revision; `signingIn` names a Claude account whose login has none to give yet. */
function shell(revision: number, signingIn?: string): (claudeAccountId?: string) => EnvSnapshot {
  return (claudeAccountId) => {
    if (claudeAccountId && claudeAccountId === signingIn) throw new Error(`${claudeAccountId} is signing in`);
    const env = { PATH: "/usr/bin", OPENORC_CODEX_BIN: "/usr/bin/codex", OPENORC_CLAUDE_BIN: "/usr/bin/claude" };
    return { revision, shell: "/bin/zsh", path: env.PATH, binaries: { claude: env.OPENORC_CLAUDE_BIN, codex: env.OPENORC_CODEX_BIN, opencode: null }, env };
  };
}

function mac({ harnesses = ["codex", "claude"] as HarnessId[], environment }: { harnesses?: HarnessId[]; environment?: () => (claudeAccountId?: string) => EnvSnapshot } = {}) {
  const db = Db.memory();
  databases.push(db);
  let now = start;
  const system = { info: vi.fn(async () => installed), infoFor: vi.fn(async () => installed) };
  const codex = vi.fn(async () => codexAnswer);
  const claude = vi.fn(async (): Promise<ClaudeUsageResult> => claudeAnswer);
  const usage = new ProviderUsageService(db, system, { codex, claude }, environment && ((id) => environment()(id)), () => now);
  const availability = async (): Promise<HarnessAvailability[]> => installed.harnesses.map(({ id, state }) => ({ id, state: harnesses.includes(id) ? state : "not_found" }));
  return {
    db,
    usage,
    codex,
    claude,
    read: () => readPlanLimits({ db, usage, availability }),
    later: (ms: number) => void (now += ms),
  };
}

describe("plan limits for a phone", () => {
  it("answers Codex, then each enabled Claude account, with the shares and plans and nothing of who they belong to", async () => {
    const { db, read } = mac();
    claudeAccounts.add(db, "Work");
    const limits = await read();
    expect(limits.map(({ id, name, plan, status }) => [id.split(":")[0], name, plan, status])).toEqual([
      ["codex", "Codex", "Pro", "available"],
      ["claude", "Claude · Existing CLI login", "Max", "available"],
      ["claude", "Claude · Work", "Max", "available"],
    ]);
    expect(limits[0]!.windows.map((window) => [window.label, window.remainingPercent])).toEqual([
      ["5-hour window", 88],
      ["7-day window", 54],
    ]);
    expect(limits[1]!.windows.map((window) => window.label)).toEqual(["5-hour window", "7-day window · all models"]);
    expect(limits.map((account) => Object.keys(account))).toEqual(limits.map(() => ["id", "provider", "name", "plan", "status", "windows", "refreshedAt"]));
    const sent = JSON.stringify(limits);
    for (const secret of ["@", "example.com", "ChatGPT", "confirmationToken", "/", "chatgpt.com", "localRuns", "source", "message"]) expect(sent).not.toContain(secret);
  });

  it("names a lone Claude account plain Claude, and leaves out disabled accounts and a harness the Mac does not have", async () => {
    const { db, read } = mac({ harnesses: ["claude"] });
    const work = claudeAccounts.add(db, "Work");
    claudeAccounts.update(db, { id: work.id, enabled: false });
    expect((await read()).map((account) => account.name)).toEqual(["Claude"]);
  });

  it("drops what Claude said when it could not report, and keeps one account's failure on its own card", async () => {
    const { claude, read } = mac();
    claude.mockResolvedValue({ status: "unavailable", detail: "token expired for /Users/me/.claude-work" });
    const limits = await read();
    expect(limits.map((account) => [account.name, account.status, account.windows.length])).toEqual([
      ["Codex", "available", 2],
      ["Claude", "unavailable", 0],
    ]);
    expect(JSON.stringify(limits)).not.toMatch(/token|\.claude-work/);
  });

  it("answers from a report younger than a minute, the desktop's own included, and reads again after it", async () => {
    const { usage, codex, claude, read, later } = mac();
    await usage.read("codex");
    await read();
    expect([codex.mock.calls.length, claude.mock.calls.length]).toEqual([1, 1]);
    later(PLAN_LIMITS_MAX_AGE_MS - 1);
    await Promise.all([read(), read()]);
    expect([codex.mock.calls.length, claude.mock.calls.length]).toEqual([1, 1]);
    later(1);
    await Promise.all([read(), read()]);
    expect([codex.mock.calls.length, claude.mock.calls.length]).toEqual([2, 2]);
  });

  it("reads an account again at once after it signs in or out", async () => {
    const { usage, claude, read, later } = mac();
    await read();
    later(minute / 2);
    usage.forgetClaudeAccount();
    await read();
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it("neither keeps nor joins a read that started before the account signed in again", async () => {
    const { usage, claude, read } = mac({ harnesses: ["claude"] });
    const session = (percent: number): ClaudeUsageResult => ({ ...claudeAnswer, usage: { limits: [{ kind: "session", group: "session", percent }] } });
    const held = () => {
      let finish!: (answer: ClaudeUsageResult) => void;
      claude.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      return (percent: number) => finish(session(percent));
    };
    const shown = async (limits: Promise<Awaited<ReturnType<typeof read>>>) => (await limits)[0]!.windows[0]!.usedPercent;
    const finishOld = held();
    const old = read();
    await vi.waitFor(() => expect(claude).toHaveBeenCalledTimes(1));
    usage.forgetClaudeAccount();
    // The phone rereads as the sign-in pushes its refresh, while the old login's read is still running.
    const finishNew = held();
    const signedIn = read();
    await vi.waitFor(() => expect(claude).toHaveBeenCalledTimes(2));
    finishOld(10);
    expect(await shown(old)).toBe(10);
    const joined = read();
    finishNew(90);
    expect([await shown(signedIn), await shown(joined), await shown(read())]).toEqual([90, 90, 90]);
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it("reads again within the minute once a Rescan changes the environment the CLIs run in", async () => {
    let revision = 1;
    const { codex, claude, read } = mac({ environment: () => shell(revision) });
    await read();
    await read();
    expect([codex.mock.calls.length, claude.mock.calls.length]).toEqual([1, 1]);
    revision = 2;
    await read();
    expect([codex.mock.calls.length, claude.mock.calls.length]).toEqual([2, 2]);
  });

  it("answers the other accounts while one is signing in, and only that card says it could not read", async () => {
    let signingIn: string | undefined;
    const { db, read } = mac({ environment: () => shell(1, signingIn) });
    signingIn = claudeAccounts.add(db, "Work").id;
    expect((await read()).map((account) => [account.name, account.status])).toEqual([
      ["Codex", "available"],
      ["Claude · Existing CLI login", "available"],
      ["Claude · Work", "error"],
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "@openorc/db";
import type { AntigravityUsageResult, readAntigravityUsage } from "@openorc/agents";
import type { SystemInfo } from "@openorc/protocol";
import { normalizeAntigravity, ProviderUsageService } from "./provider-usage.js";
import type { EnvSnapshot } from "./shell-environment.js";

const at = Date.parse("2027-01-14T00:00:00Z");
const groups = [
  {
    name: "Gemini Models",
    buckets: [
      { id: "gemini-weekly", name: "Weekly Limit Remaining", remaining_fraction: 0.4261, reset_time: "2027-01-20T00:00:00Z" },
      { id: "gemini-five-hour", name: "5 Hour Limit Remaining", remaining_fraction: 0, reset_time: "2027-01-14T05:00:00Z" },
    ],
  },
  { name: "Claude and GPT models", buckets: [{ id: "3p-weekly", name: "Weekly Limit Remaining", remaining_fraction: 1 }] },
];
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(snapshot?: EnvSnapshot) {
  const db = Db.memory();
  databases.push(db);
  const systemInfo: SystemInfo = { dataDir: "/tmp", harnesses: [{ id: "antigravity", state: "ready", path: "agy", version: "1.5.3", revision: 1 }], gh: { installed: false, path: null } };
  const system = { info: vi.fn(async () => systemInfo), infoFor: vi.fn(async () => systemInfo) };
  const read = vi.fn<typeof readAntigravityUsage>(async () => ({ status: "ok", groups }));
  const service = new ProviderUsageService(db, system, { antigravity: read }, snapshot && (() => snapshot), () => at);
  return { read, service, system };
}

describe("Antigravity account usage", () => {
  it("preserves separate model pools, remaining fractions and reset times without inventing a missing window", () => {
    expect(normalizeAntigravity(groups, at)).toEqual([
      {
        id: "gemini-weekly",
        label: "Weekly Limit · Gemini Models",
        group: "Gemini Models",
        usedPercent: 57.39,
        remainingPercent: 42.61,
        resetsAt: Date.parse("2027-01-20T00:00:00Z"),
        observedAt: at,
        exhausted: false,
      },
      {
        id: "gemini-five-hour",
        label: "5 Hour Limit · Gemini Models",
        group: "Gemini Models",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: Date.parse("2027-01-14T05:00:00Z"),
        observedAt: at,
        exhausted: true,
      },
      { id: "3p-weekly", label: "Weekly Limit · Claude and GPT models", group: "Claude and GPT models", usedPercent: 0, remainingPercent: 100, resetsAt: null, observedAt: at, exhausted: false },
    ]);
    expect(normalizeAntigravity([{ name: "Gemini", buckets: [{ id: "gemini-weekly", name: "Weekly", remaining_fraction: null }] }], at)[0]).toMatchObject({
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      exhausted: false,
    });
  });

  it("reads the resolved CLI and environment and shares the fresh report with the plan-limits cache", async () => {
    const snapshot: EnvSnapshot = {
      revision: 1,
      shell: "/bin/sh",
      path: "/opt/agents",
      env: { HOME: "/tmp/account", PATH: "/opt/agents" },
      binaries: { codex: null, claude: null, opencode: null, omp: null, cursor: null, pi: null, antigravity: "/opt/agents/agy", fx: null },
    };
    const { service, read, system } = setup(snapshot);
    const report = await service.read("antigravity");
    expect(report).toMatchObject({
      provider: "antigravity",
      status: "available",
      source: "Antigravity CLI · account usage",
      refreshedAt: at,
      message: null,
      windows: normalizeAntigravity(groups, at),
    });
    expect(system.infoFor).toHaveBeenCalledWith(snapshot);
    expect(read).toHaveBeenCalledWith({ binary: "/opt/agents/agy", env: snapshot.env });
    expect(await service.recent("antigravity", undefined, 60_000)).toBe(report);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("distinguishes API billing, signed-out, empty and failed reports without retaining old quota", async () => {
    const { service, read } = setup();
    await service.read("antigravity");
    const cases: [AntigravityUsageResult, string, RegExp][] = [
      [{ status: "unsupported" }, "unavailable", /Gemini API key/],
      [{ status: "disconnected" }, "disconnected", /agy acp --login/],
      [{ status: "unavailable" }, "error", /Could not read Antigravity/],
      [{ status: "ok", groups: [] }, "unavailable", /no model quotas/],
    ];
    for (const [answer, status, message] of cases) {
      read.mockResolvedValueOnce(answer);
      const report = await service.read("antigravity");
      expect(report.status).toBe(status);
      expect(report.message).toMatch(message);
      expect(report.windows).toEqual([]);
    }
    read.mockRejectedValueOnce(new Error("fixture-secret in provider response"));
    const failed = await service.read("antigravity");
    expect(failed.status).toBe("error");
    expect(JSON.stringify(failed)).not.toContain("fixture-secret");
  });
});

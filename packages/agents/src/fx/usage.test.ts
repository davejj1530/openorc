import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFxUsage } from "./usage.js";

const report = { kind: "usage", schema_version: 2, source: "ai_gateway", status: "ready", fetched_at_ms: 1_800_000_000_000 };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(payload: unknown = report, mode = "reply", credits: unknown = { kind: "credits", balance: "12.50", plan: null }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-fx-usage-test-"));
  dirs.push(dir);
  const binary = path.join(dir, "fx");
  const log = path.join(dir, "calls.jsonl");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pwd: process.env.PWD, home: process.env.HOME, pid: process.pid, provider: process.env.FX_PROVIDER, model: process.env.FX_MODEL, upgrade: process.env.FX_AUTO_UPGRADE, sound: process.env.FX_SOUND }) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "oversize") process.stdout.write("x".repeat(2 * 1024 * 1024));
else {
  process.stderr.write("fixture-secret");
  process.stdout.write(JSON.stringify(process.argv[2] === "credits" ? ${JSON.stringify(credits)} : ${JSON.stringify(payload)}));
  process.exitCode = mode === "error" || (mode === "credits-error" && process.argv[2] === "credits") ? 1 : 0;
}
`,
    { mode: 0o755 },
  );
  return {
    binary,
    env: { HOME: dir, PWD: "/tmp/example-project", FX_MODEL: "gateway/example" },
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

describe.skipIf(process.platform === "win32")("fx account metadata commands", () => {
  it("queries usage and credits outside the project, preserving auth and isolating the selected connection", async () => {
    const f = await fixture({ ...report, profile: { email: "fixture@example.com" }, totals: { spend: 123 } });
    expect(await readFxUsage({ ...f, model: "gateway/anthropic/example" })).toEqual({ status: "ok", report, credits: { kind: "credits", balance: "12.50", plan: null } });
    const calls = await f.calls();
    expect(calls.map((call) => call.args)).toEqual([
      ["usage", "--period", "today", "--json"],
      ["credits", "--json"],
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({ home: f.env.HOME, provider: "gateway", upgrade: "0", sound: "0" });
      expect(call.model).toBe("anthropic/example");
      expect(call.pwd).toBe(call.cwd);
      expect(call.cwd).not.toBe(f.env.PWD);
      await expect(stat(call.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(f.env.FX_MODEL).toBe("gateway/example");
  });

  it.each(["chatgpt", "grok"])("does not substitute Gateway credits for %s allowances", async (source) => {
    const f = await fixture({ ...report, source });
    expect(await readFxUsage(f)).toMatchObject({ status: "ok", credits: null });
    expect(await f.calls()).toHaveLength(1);
  });

  it("preserves missing metrics, zero, and cached failure states without exposing profile or error content", async () => {
    const f = await fixture(
      {
        ...report,
        source: "chatgpt",
        status: "failed",
        reason: "refused",
        codex: {
          plan: "Pro",
          profile: { name: "Example" },
          limits: [{ name: "Codex", primary: { used_percent: 0, window_seconds: 18000, resets_at_ms: "bad" }, secondary: { used_percent: -1, window_seconds: 604800 } }],
        },
      },
      "error",
    );
    const result = await readFxUsage(f);
    expect(result).toMatchObject({
      status: "ok",
      report: { status: "failed", reason: "refused", codex: { limits: [{ primary: { used_percent: 0, resets_at_ms: null }, secondary: { used_percent: null } }] } },
    });
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|profile|Example/);
  });

  it.each([
    { name: "unknown schema", payload: { ...report, schema_version: 3 }, mode: "reply" },
    { name: "invalid JSON shape", payload: { error: "fixture-secret" }, mode: "reply" },
    { name: "nonzero success response", payload: report, mode: "error" },
  ])("rejects $name", async ({ payload, mode }) => {
    expect(await readFxUsage(await fixture(payload, mode))).toEqual({ status: "unavailable" });
  });

  it("retains allowances if credits fail and rejects nonnumeric balances", async () => {
    expect(await readFxUsage(await fixture(report, "credits-error"))).toEqual({ status: "ok", report, credits: null });
    expect(await readFxUsage(await fixture(report, "reply", { kind: "credits", balance: "fixture-secret" }))).toMatchObject({ status: "ok", credits: { balance: null } });
  });

  it.each(["unsupported_provider", "no_gateway_sign_in", "refresh_needed", "refused"])("skips credits for an unavailable connection: %s", async (reason) => {
    const f = await fixture({ ...report, status: "unavailable", reason }, "error");
    expect(await readFxUsage({ ...f, model: "codex/example" })).toMatchObject({ status: "ok", credits: null, report: { reason } });
    expect(await f.calls()).toHaveLength(1);
  });

  it("bounds process time and output and cleans up after a missing binary", async () => {
    const f = await fixture(report, "timeout");
    expect(await readFxUsage({ ...f, timeoutMs: 1000 })).toEqual({ status: "unavailable" });
    const [call] = await f.calls();
    expect(() => process.kill(call.pid, 0)).toThrow();
    await expect(stat(call.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFxUsage(await fixture(report, "oversize"))).toEqual({ status: "unavailable" });
    expect(await readFxUsage({ binary: "/tmp/missing-fx", env: {} })).toEqual({ status: "unavailable" });
  }, 15_000);
});

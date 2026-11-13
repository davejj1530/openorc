import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAntigravityUsage } from "./usage.js";

const answer = {
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", remaining_fraction: 0.42, reset_time: "2027-01-20T00:00:00Z" },
            { id: "gemini-five-hour", name: "5 Hour Limit Remaining", remaining_fraction: 1 },
          ],
        },
      ],
    },
  },
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** An executable boundary: records the launch, then responds like the native metadata command. */
async function fixture(payload: unknown = answer, mode: "reply" | "error" | "timeout" | "oversize" = "reply") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-quota-fixture-"));
  dirs.push(dir);
  const binary = path.join(dir, "agy");
  const calls = path.join(dir, "calls.json");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pwd: process.env.PWD, home: process.env.HOME, pid: process.pid }));
const mode = ${JSON.stringify(mode)};
if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "oversize") process.stdout.write("x".repeat(2 * 1024 * 1024));
else { process.stdout.write(JSON.stringify(${JSON.stringify(payload)})); process.exitCode = mode === "error" ? 1 : 0; }
`,
    { mode: 0o755 },
  );
  return { binary, env: { HOME: dir, PWD: "/project" }, calls: async () => JSON.parse(await readFile(calls, "utf8")) };
}

describe.skipIf(process.platform === "win32")("Antigravity usage command", () => {
  it("reads structured quotas with the existing home, outside the project, without a model prompt or interactive login", async () => {
    const f = await fixture();
    expect(await readAntigravityUsage(f)).toEqual({ status: "ok", groups: answer.command.data.groups });
    const call = await f.calls();
    expect(call.args).toEqual(["--print", "/usage", "--output-format", "json", "--print-timeout", "20s", "--settings", '{"useG1Credits":false}']);
    expect(call.home).toBe(f.env.HOME);
    expect(call.pwd).toBe(call.cwd);
    expect(call.cwd).not.toBe("/project");
    await expect(stat(call.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not substitute a cached Google account's quota for API-key billing", async () => {
    expect(await readAntigravityUsage({ binary: "/missing/agy", env: { GEMINI_API_KEY: "fixture-key" } })).toEqual({ status: "unsupported" });
    const f = await fixture();
    expect(await readAntigravityUsage({ ...f, env: { ...f.env, GEMINI_API_KEY: " " } })).toMatchObject({ status: "ok" });
  });

  it("keeps unknown fractions and reset dates unknown while preserving valid zero", async () => {
    const buckets = [
      { id: "a", name: "Weekly", remaining_fraction: 0, reset_time: "2027-01-20T08:00:00+08:00" },
      { id: "b", name: "Weekly", remaining_fraction: 2, reset_time: "not a date" },
      { id: "c", name: "Weekly", remaining_fraction: "0.5" },
      { id: "d", name: "Weekly" },
    ];
    const f = await fixture({ ...answer, command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets }] } } });
    expect(await readAntigravityUsage(f)).toEqual({
      status: "ok",
      groups: [{ name: "Gemini Models", buckets: [buckets[0], { ...buckets[1], remaining_fraction: null, reset_time: null }, { ...buckets[2], remaining_fraction: null }, buckets[3]] }],
    });
  });

  it.each([
    { name: "empty output", payload: null },
    { name: "unsupported output", payload: { secret: "fixture-secret" } },
    { name: "a model-turn response", payload: { ...answer, num_turns: 1 } },
    { name: "a different command", payload: { ...answer, command: { name: "other", data: answer.command.data } } },
  ])("rejects $name without forwarding its contents", async ({ payload }) => {
    expect(await readAntigravityUsage(await fixture(payload))).toEqual({ status: "unavailable" });
  });

  it.each([
    { name: "an unsuccessful command", payload: answer, status: "unavailable" },
    { name: "an authentication error", payload: { status: "ERROR", error: "authentication failed or timed out" }, status: "disconnected" },
    { name: "a provider error", payload: { status: "ERROR", error: "provider failure with fixture-secret" }, status: "unavailable" },
  ])("classifies $name without forwarding its contents", async ({ payload, status }) => {
    expect(await readAntigravityUsage(await fixture(payload, "error"))).toEqual({ status });
  });

  it("bounds time and output, stops the process, and tolerates a missing CLI", async () => {
    const f = await fixture(answer, "timeout");
    expect(await readAntigravityUsage({ ...f, timeoutMs: 2000 })).toEqual({ status: "unavailable" });
    const call = await f.calls();
    expect(() => process.kill(call.pid, 0)).toThrow();
    await expect(stat(call.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readAntigravityUsage(await fixture(answer, "oversize"))).toEqual({ status: "unavailable" });
    expect(await readAntigravityUsage({ binary: path.join(os.tmpdir(), "openorc-missing-agy"), env: {} })).toEqual({ status: "unavailable" });
  }, 15_000);
});

it.skipIf(!process.env["OPENORC_TEST_ANTIGRAVITY_BIN"])(
  "the native CLI reports missing login without opening authentication or running a turn",
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "openorc-quota-native-"));
    dirs.push(home);
    expect(await readAntigravityUsage({ binary: process.env["OPENORC_TEST_ANTIGRAVITY_BIN"], env: { HOME: home, PATH: process.env["PATH"] } })).toEqual({ status: "disconnected" });
  },
  30_000,
);

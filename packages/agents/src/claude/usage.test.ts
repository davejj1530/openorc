import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeUsage } from "./usage.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A stand-in CLI that answers initialize, then answers get_usage the way `mode` says. */
async function fixture(mode: "ok" | "unsupported" | "error" | "exit" | "timeout" = "ok") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-claude-usage-"));
  dirs.push(dir);
  const binary = path.join(dir, "claude");
  const calls = path.join(dir, "calls");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), claudecode: process.env.CLAUDECODE ?? null }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, line + "\\n");
  const answer = (response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: request.request_id, ...response } }) + "\\n");
  if (request.request.subtype === "initialize") return answer({ subtype: "success", response: { models: [] } });
  const mode = ${JSON.stringify(mode)};
  if (mode === "timeout") return;
  if (mode === "exit") return process.exit(1);
  if (mode === "error") return answer({ subtype: "error", error: "get_usage is not supported in this context" });
  if (mode === "unsupported") return answer({ subtype: "success", response: { subscription_type: null, rate_limits_available: false, rate_limits: null } });
  answer({
    subtype: "success",
    response: {
      session: { total_cost_usd: 0 },
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 27, resets_at: "2026-09-24T16:40:00Z" }, extra_usage: { is_enabled: false } },
      behaviors: null,
    },
  });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  return {
    binary,
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

describe.skipIf(process.platform === "win32")("readClaudeUsage", () => {
  it("asks the CLI for its plan windows over control requests and never runs a turn", async () => {
    const f = await fixture();
    expect(await readClaudeUsage({ binary: f.binary, env: { ...process.env, CLAUDECODE: "1" } })).toEqual({
      status: "ok",
      usage: { five_hour: { utilization: 27, resets_at: "2026-09-24T16:40:00Z" }, extra_usage: { is_enabled: false } },
      subscriptionType: "max",
    });
    const calls = await f.calls();
    expect(calls).toHaveLength(3);
    expect(calls[0].claudecode).toBeNull();
    expect(calls[0].args).toEqual(expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", JSON.stringify({ disableAllHooks: true })]));
    expect(calls[0].args[calls[0].args.indexOf("--tools") + 1]).toBe("");
    expect(calls[1]).toMatchObject({ type: "control_request", request: { subtype: "initialize", hooks: {} } });
    expect(calls[2]).toMatchObject({ type: "control_request", request: { subtype: "get_usage", skip_behaviors: true } });
  });
  it("tells an API key or cloud provider login apart from a failed probe", async () => {
    expect(await readClaudeUsage({ binary: (await fixture("unsupported")).binary })).toEqual({ status: "unsupported" });
    expect(await readClaudeUsage({ binary: (await fixture("error")).binary })).toEqual({ status: "unavailable", detail: "get_usage is not supported in this context" });
  });
  it("bounds the probe and reports early exit or a missing CLI without throwing", async () => {
    expect(await readClaudeUsage({ binary: (await fixture("timeout")).binary, timeoutMs: 200 })).toEqual({ status: "unavailable", detail: "Claude timed out while reporting usage" });
    expect(await readClaudeUsage({ binary: (await fixture("exit")).binary })).toEqual({ status: "unavailable", detail: "Claude exited before reporting usage" });
    expect(await readClaudeUsage({ binary: path.join(os.tmpdir(), "openorc-no-such-claude") })).toEqual({ status: "unavailable", detail: "Claude could not start" });
  });
});

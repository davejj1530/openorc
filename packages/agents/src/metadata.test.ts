import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeModels } from "./claude/models.js";
import { CodexAdapter } from "./codex/adapter.js";
import { consumeCodexReset } from "./codex/usage.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(mode = "ok") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-metadata-"));
  dirs.push(dir);
  const binary = path.join(dir, "provider");
  const calls = path.join(dir, "calls");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2)})+"\\n");
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const request=JSON.parse(line); fs.appendFileSync(${JSON.stringify(calls)},line+"\\n");
 const send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");
 if(request.type==="control_request") {
  if(${JSON.stringify(mode)}==="timeout") return;
  if(${JSON.stringify(mode)}==="exit") return process.exit(1);
  return send({type:"control_response",response:{subtype:"success",request_id:request.request_id,response:{models:[{value:"sonnet",resolvedModel:"claude-sonnet-9",displayName:"Sonnet 9",supportsEffort:true,supportedEffortLevels:["low","xhigh"],supportsFastMode:true}],fast_mode_state:"off",fast_mode_disabled_reason:"extra_usage_disabled"}}});
 }
 if(request.id===undefined) return;
 let result={};
 if(request.method==="account/read") result={account:{type:"chatgpt"}};
 if(request.method==="account/rateLimits/read") result={rateLimitResetCredits:{availableCount:1,credits:null}};
 if(request.method==="account/rateLimitResetCredit/consume") {
  if(${JSON.stringify(mode)}==="unsupported") return send({id:request.id,error:{code:-32601,message:"Method not found"}});
  result={outcome:"alreadyRedeemed"};
 }
 if(request.method==="model/list") result={data:[{id:request.params.cursor?"second":"first",model:request.params.cursor?"gpt-new":"gpt-old",displayName:"Fixture",isDefault:!request.params.cursor,supportedReasoningEfforts:[{reasoningEffort:"medium"}],defaultReasoningEffort:"medium"}],nextCursor:request.params.cursor?null:"page-2"};
 send({id:request.id,result});
});
setInterval(()=>{},1000);
`,
    { mode: 0o755 },
  );
  return {
    binary,
    env: {},
    revision: 1,
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
  };
}

describe.skipIf(process.platform === "win32")("metadata-only CLI connections", () => {
  it("reads Claude initialization without sending a user turn or enabling hooks/tools/MCP", async () => {
    const f = await fixture();
    expect(await listClaudeModels(f)).toEqual({
      models: [{ value: "sonnet", resolvedModel: "claude-sonnet-9", displayName: "Sonnet 9", supportsEffort: true, supportedEffortLevels: ["low", "xhigh"], supportsFastMode: true }],
      fastModeDisabledReason: "extra_usage_disabled",
    });
    const calls = await f.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ type: "control_request", request: { subtype: "initialize", hooks: {} } });
    // Asking for Fast only makes the CLI report the account's Fast access.
    expect(calls[0].args).toEqual(
      expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", JSON.stringify({ mcpServers: {} }), JSON.stringify({ disableAllHooks: true, fastMode: true })]),
    );
    expect(calls[0].args[calls[0].args.indexOf("--tools") + 1]).toBe("");
  });
  it("bounds Claude probes and reports early exit", async () => {
    await expect(listClaudeModels(await fixture("timeout"), 100)).rejects.toThrow("timed out");
    await expect(listClaudeModels(await fixture("exit"))).rejects.toThrow("exited");
  });
  it("follows Codex model pagination without creating a thread", async () => {
    const f = await fixture();
    const rows = await new CodexAdapter({ onApproval: async () => "deny" }).listModels(f);
    expect(rows.map((row) => row.model)).toEqual(["gpt-old", "gpt-new"]);
    const calls = (await f.calls()).slice(1);
    expect(calls.map((call) => call.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
    expect(calls[3].params.cursor).toBe("page-2");
  });
  it("rechecks before fixture redemption and preserves the idempotency key", async () => {
    const f = await fixture();
    let checked = false;
    expect(
      await consumeCodexReset({ idempotencyKey: "same-attempt", creditId: "fixture-credit" }, f, (report) => {
        checked = true;
        expect(report.account).toEqual({ type: "chatgpt" });
      }),
    ).toBe("alreadyRedeemed");
    expect(checked).toBe(true);
    const calls = (await f.calls()).slice(1);
    expect(calls.map((c) => c.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read", "account/rateLimitResetCredit/consume"]);
    expect(calls.at(-1).params).toEqual({ idempotencyKey: "same-attempt", creditId: "fixture-credit" });
  });
  it("never calls consume after a failed account check and detects unsupported CLIs", async () => {
    const f = await fixture();
    await expect(
      consumeCodexReset({ idempotencyKey: "blocked" }, f, () => {
        throw new Error("Account changed");
      }),
    ).rejects.toThrow("Account changed");
    expect((await f.calls()).some((c) => c.method === "account/rateLimitResetCredit/consume")).toBe(false);
    expect(await consumeCodexReset({ idempotencyKey: "unsupported" }, await fixture("unsupported"), () => {})).toBe("unsupported");
  });
});

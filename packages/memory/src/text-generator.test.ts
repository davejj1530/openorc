import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TextGenerator } from "./text-generator.js";
import { Extractor } from "./extractor.js";

let dir: string;
let binary: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "openorc-text-test-"));
  binary = join(dir, "model.cjs");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(args));
if (process.env.STALL_GENERATION) setTimeout(() => {}, 60000);
else if (args.includes('-o')) {
  process.stdin.resume();
  process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({title:'CSV export filters'})));
} else if (args[0] === 'run') {
  fs.writeFileSync(process.env.CAPTURE_CONFIG, process.env.OPENCODE_CONFIG_CONTENT);
  console.log(JSON.stringify({type:'step_start',part:{}}));
  console.log(JSON.stringify({type:'text',part:{text:JSON.stringify({title:'CSV export filters'})}}));
  if (process.env.FAIL_OPEN_CODE) console.log(JSON.stringify({type:'error',error:{message:'failed'}}));
} else {
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    const value = input.includes('durable memory') ? {summary:{request:'CSV',workDone:'Export',outcome:'success',openItems:[]},memories:[]} : {title:'CSV export filters'};
    console.log(JSON.stringify({result:JSON.stringify(value)}));
  });
}
`,
    { mode: 0o700 },
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("shared background CLI runner", () => {
  it("runs title generation with the selected Codex model and low reasoning", async () => {
    const capture = join(dir, "codex-args.json");
    const generator = new TextGenerator({ provider: "codex", model: "gpt-5.6-luna", effort: "low", binary, env: { CAPTURE_ARGS: capture }, timeoutMs: 1000 });
    expect(await generator.title({ request: "Add CSV", reply: "Done" })).toBe("CSV export filters");
    const args: string[] = JSON.parse(await readFile(capture, "utf8"));
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-luna");
    expect(args).toContain("mcp_servers={}");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("keeps Claude memory extraction working through the shared runner, with the prompt kept off the command line", async () => {
    const capture = join(dir, "claude-args.json");
    const extractor = new Extractor({ provider: "claude", model: "claude-haiku-4-5-20251001", binary, env: { CAPTURE_ARGS: capture } });
    const result = await extractor.extract({ prompts: ["Private CSV request"], assistant: [], toolLines: [], filesTouched: [] }, { taskTitle: "Export", taskSpec: null });
    expect(result?.summary.outcome).toBe("success");
    const args: string[] = JSON.parse(await readFile(capture, "utf8"));
    expect(args.slice(0, 2)).toEqual(["-p", "--model"]);
    expect(args.join(" ")).not.toContain("Private CSV request");
  });

  it("runs OpenCode with its provider model and tools denied, ignoring progress and rejecting error events", async () => {
    const capture = join(dir, "opencode-args.json");
    const config = join(dir, "opencode-config.json");
    const options = { provider: "opencode" as const, model: "openrouter/openai/gpt-5-mini", binary, env: { CAPTURE_ARGS: capture, CAPTURE_CONFIG: config } };
    expect(await new TextGenerator(options).title({ request: "CSV", reply: null })).toBe("CSV export filters");
    const args: string[] = JSON.parse(await readFile(capture, "utf8"));
    expect(args[args.indexOf("--model") + 1]).toBe(options.model);
    expect(args).toContain("--standalone");
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({ permission: "deny", share: "disabled", agent: { "openorc-text-generation": { steps: 1, permission: "deny" } } });
    expect(await new TextGenerator({ ...options, env: { ...options.env, FAIL_OPEN_CODE: "1" } }).title({ request: "CSV", reply: null })).toBeNull();
  });

  it("returns null when the selected CLI is missing", async () => {
    expect(await new TextGenerator({ provider: "claude", binary: join(dir, "missing") }).title({ request: "CSV", reply: null })).toBeNull();
  });

  it("returns null for a timed-out or synchronously rejected CLI invocation", async () => {
    expect(
      await new TextGenerator({ provider: "claude", binary, env: { CAPTURE_ARGS: join(dir, "timeout-args.json"), STALL_GENERATION: "1" }, timeoutMs: 100 }).title({ request: "CSV", reply: null }),
    ).toBeNull();
    expect(await new TextGenerator({ provider: "claude", binary: "bad\0binary" }).title({ request: "CSV", reply: null })).toBeNull();
  });
});

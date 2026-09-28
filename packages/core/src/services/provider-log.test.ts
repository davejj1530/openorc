import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { ProviderLog } from "./provider-log.js";

type RawEvent = Extract<AgentEvent, { type: "raw" }>;
const raw = (agent: RawEvent["agent"], payload: unknown): RawEvent => ({ type: "raw", runId: "run-1", ts: 1, agent, payload });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-provider-log-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async () => {
  const files = (await readdir(dir)).sort();
  const text = (await Promise.all(files.map((file) => readFile(path.join(dir, file), "utf8")))).join("");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("ProviderLog", () => {
  it("keeps finished lines, skips token fragments a later line repeats, and redacts secrets", async () => {
    const log = new ProviderLog(dir);
    log.write(raw("claude", { type: "stream_event", event: { type: "content_block_delta", delta: { text: "Hel" } } }));
    log.write(raw("claude", { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }));
    log.write(raw("claude", { type: "stream_event", event: { type: "message_start", message: { usage: { cache_read_input_tokens: 9 } } } }));
    log.write(raw("codex", { method: "item/agentMessage/delta", params: { delta: "Hel" } }));
    log.write(raw("codex", { method: "item/commandExecution/outputDelta", params: { delta: "ok" } }));
    log.write(raw("codex", { method: "item/completed", params: { item: { type: "agentMessage", text: "Hello" } } }));
    log.write(raw("opencode", { sessionUpdate: "agent_message_chunk", content: { text: "Hel" } }));
    log.write(raw("claude", { type: "assistant", message: { content: [{ type: "text", text: "key sk-ant-abcdefghijklmnopqrstuvwxyz0123" }] } }));
    await log.close();
    const kept = await lines();
    expect(kept.map((line) => JSON.stringify(line.payload))).toEqual([
      expect.stringContaining("message_start"),
      expect.stringContaining("item/completed"),
      // OpenCode never repeats its chunks, so they are the only record of what it sent.
      expect.stringContaining("agent_message_chunk"),
      expect.stringContaining("[redacted:anthropic-key]"),
    ]);
    expect(JSON.stringify(kept)).not.toContain("sk-ant-abcdefghij");
  });

  it("replaces an oversized line with its beginning and size", async () => {
    const log = new ProviderLog(dir, { maxRecordBytes: 200 });
    log.write(raw("claude", { type: "user", message: "x".repeat(5_000) }));
    await log.close();
    const [line] = await lines();
    expect(line).toMatchObject({ runId: "run-1", agent: "claude", truncated: true });
    expect(line?.["bytes"]).toBeGreaterThan(5_000);
    expect(String(line?.["preview"])).toHaveLength(200);
  });

  it("rotates by size and removes the oldest files past the size limit", async () => {
    let clock = Date.now();
    const log = new ProviderLog(dir, { maxFileBytes: 300, maxTotalBytes: 1_000, now: () => (clock += 1_000) });
    for (let i = 0; i < 8; i += 1) log.write(raw("claude", { type: "result", result: `${i}`.repeat(250) }));
    await log.close();
    const kept = await lines();
    // One line per file; only the newest fit the 1,000-byte limit, and the last one written always survives.
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThan(8);
    expect(JSON.stringify(kept.at(-1))).toContain("7".repeat(250));
  });

  it("removes files older than the age limit when it next starts a file", async () => {
    const first = new ProviderLog(dir);
    first.write(raw("claude", { type: "result", result: "old" }));
    await first.close();
    const [stale] = await readdir(dir);
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await utimes(path.join(dir, stale!), old, old);
    const next = new ProviderLog(dir, { now: () => Date.now() + 1_000 });
    next.write(raw("claude", { type: "result", result: "new" }));
    await next.close();
    expect(await readdir(dir)).not.toContain(stale);
    expect(JSON.stringify(await lines())).toContain("new");
  });

  it("starts a new file once the current one is a day old, and never throws when the folder cannot be made", async () => {
    let clock = Date.now();
    const log = new ProviderLog(dir, { now: () => clock });
    log.write(raw("claude", { type: "assistant", n: 1 }));
    clock += 25 * 60 * 60 * 1000;
    log.write(raw("claude", { type: "assistant", n: 2 }));
    await log.close();
    expect((await readdir(dir)).filter((name) => name.endsWith(".ndjson"))).toHaveLength(2);

    const blocked = path.join(dir, "file-not-folder");
    await writeFile(blocked, "");
    const stuck = new ProviderLog(path.join(blocked, "logs"));
    expect(() => stuck.write(raw("claude", { type: "assistant", n: 3 }))).not.toThrow();
    await stuck.close();
  });
});

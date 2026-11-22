import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { runs, type Db } from "@openorc/db";
import { defaultOrclingLook, type Run, type RunSpec } from "@openorc/protocol";
import { cloudMac, type CloudMac } from "../remote/test-fixtures/cloud-mac.js";
import { AppSettingsService } from "../services/settings.js";

let at: CloudMac;
beforeAll(async () => {
  at = await cloudMac();
}, 30_000);
afterAll(() => at.close());
afterEach(() => {
  vi.restoreAllMocks();
});

/** A provider whose turn never ends, so the run stays live and its tools answer. */
function working(spec: RunSpec): RunHandle {
  let exit!: (code: number) => void;
  const done = new Promise<number>((resolve) => (exit = resolve));
  return new RunHandle(spec.runId, { done, send: async () => undefined, interrupt() {}, close: () => exit(0) });
}

/** Calls one of a run's tools through the core's own MCP server, as its agent would. */
async function tool(runId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch((await at.core.mcpServer()).urlForRun(runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(8000),
  });
  const raw = await response.text();
  const line = raw.startsWith("{")
    ? raw
    : raw
        .split("\n")
        .find((entry) => entry.startsWith("data: "))!
        .slice(6);
  const payload = JSON.parse(line) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result?.isError) throw new Error(payload.result.content[0]?.text);
  return payload.result!.content[0]!.text;
}

const firstRun = (db: Db, threadId: string): Run => runs.listForThread(db, threadId)[0]!;

it("keeps an Orcling out of a thread OpenOrc Cloud holds, as the core's own tools see the cloud, while accounts are kept separate", async () => {
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(working);
  const environment = at.core.environment.current();
  vi.spyOn(at.core.environment, "current").mockReturnValue({ ...environment, binaries: { ...environment.binaries, codex: "/fixture/codex" } });
  const pip = await at.core.orclings.create({ name: "Pip", look: defaultOrclingLook, settings: { agent: "codex", model: "fixture", effort: null, fastMode: false }, permission: "allow" });
  await at.core.threads.continueThread(pip.threadId, { agent: "codex", model: "fixture", effort: undefined, attachments: undefined, mode: "act", permissionMode: "autonomous", prompt: "hi" });
  await vi.waitFor(() => expect(at.core.runs.isLive(firstRun(at.core.db, pip.threadId).id)).toBe(true));
  const pipRun = firstRun(at.core.db, pip.threadId);
  const cloudThread = { method: "threads.get", params: { id: at.cloud.threads.teammate } };

  expect(JSON.parse(await tool(pipRun.id, "orcling_app", cloudThread))).toMatchObject({ id: at.cloud.threads.teammate });
  new AppSettingsService(at.core.db).set({ claudeAccountsSeparate: true });
  await expect(tool(pipRun.id, "orcling_app", cloudThread)).rejects.toThrow(
    "Settings keeps Claude accounts separate, so you don't reach OpenOrc Cloud's threads and tasks, which no account here holds.",
  );
});

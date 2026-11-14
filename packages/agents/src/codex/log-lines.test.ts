import { expect, it } from "vitest";
import { codexStderrEvent, isCodexLogLine } from "./log-lines.js";

it("tells Codex's own log lines from anything else it writes to stderr", () => {
  expect(isCodexLogLine("2026-11-14T03:30:29.648303Z ERROR codex_app_server: Codex could not find bubblewrap on PATH. Codex will use the bundled bubblewrap in the meantime.")).toBe(true);
  expect(isCodexLogLine("2026-11-14T03:32:16.152603Z ERROR codex_core::util: Custom tool call output is missing for call id: call_a080")).toBe(true);
  expect(isCodexLogLine("2026-11-14T03:32:16.152603Z  WARN codex_core: retrying")).toBe(true);
  expect(isCodexLogLine("thread 'main' panicked at core/src/lib.rs:10:5")).toBe(false);
  expect(isCodexLogLine("error: unexpected argument '--frobnicate' found")).toBe(false);
});

it("sends a log line to the raw stream and says anything else as an error", () => {
  const log = "2026-11-14T03:30:29.648303Z ERROR codex_app_server: Codex could not find bubblewrap on PATH.";
  expect(codexStderrEvent("run", 1, log)).toEqual({ type: "raw", runId: "run", ts: 1, agent: "codex", payload: { stderr: log } });
  expect(codexStderrEvent("run", 2, "codex: command failed")).toEqual({ type: "error", runId: "run", ts: 2, message: "codex: command failed", fatal: false });
});

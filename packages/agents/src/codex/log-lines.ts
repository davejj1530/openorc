import type { AgentEvent } from "@openorc/protocol";

/**
 * Codex writes its own log to stderr as its tracing prints it: a timestamp, a level, the module, then words. Those lines
 * are the CLI's diagnostics (a sandbox helper it found a stand-in for, a tool call left without output after a
 * restart), not errors of the turn, which arrive as notifications. Anything else on stderr is still an error to say.
 */
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+\S+:\s/;

export const isCodexLogLine = (line: string): boolean => LOG_LINE.test(line);

/** What a line Codex wrote to stderr is in a run: its own log goes to the raw stream, anything else is an error to say. */
export function codexStderrEvent(runId: string, ts: number, line: string): AgentEvent {
  return isCodexLogLine(line) ? { type: "raw", runId, ts, agent: "codex", payload: { stderr: line } } : { type: "error", runId, ts, message: line, fatal: false };
}

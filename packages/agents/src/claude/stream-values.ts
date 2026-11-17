import { SESSION_ID, type AgentEvent } from "@openorc/protocol";

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A session id the CLI reported, when it is a plain name: the host keeps the session under it as a file name. */
export function sessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function contentText(content: unknown): string {
  return (
    str(content) ??
    (Array.isArray(content)
      ? content
          .filter(isRecord)
          .filter((block) => block["type"] === "text")
          .map((block) => str(block["text"]) ?? "")
          .join("\n")
      : "")
  );
}

/** A stream line not in the shape Claude Code writes, said and passed over. */
export function protocolError(runId: string, ts: number, message: string): AgentEvent {
  return { type: "error", runId, ts, message: `Malformed Claude stream line: ${message}`, fatal: false };
}

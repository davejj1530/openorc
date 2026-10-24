import type { Block } from "./transcript.js";

type ApprovalBlock = Extract<Block, { kind: "approval" }>;

/**
 * What the person needs to judge, per approval shape: the command for shell approvals, the tool arguments for MCP
 * calls, the tool input for Claude's permission prompt.
 */
export function approvalDetail(block: ApprovalBlock): unknown {
  const p = (block.input ?? {}) as Record<string, unknown>;
  if (typeof p["command"] === "string") return p["command"];
  const meta = p["_meta"] as Record<string, unknown> | undefined;
  if (meta && meta["tool_params"] !== undefined) return meta["tool_params"];
  if (p["permissions"] !== undefined) return p["permissions"];
  if (p["input"] !== undefined) return p["input"];
  return block.input;
}

/** The most of a request the card shows before the person answers it. */
const SUMMARY = { lines: 16, chars: 600 };

/**
 * A request as the approval card sums it up: what `approvalDetail` names, as text, whole when it is short; a longer one
 * keeps its start and its end around a "…" line, so the last line of a long command is read before it is allowed.
 */
export function approvalSummary(block: ApprovalBlock): string {
  const detail = approvalDetail(block);
  if (detail === null || detail === undefined || (typeof detail === "object" && Object.keys(detail).length === 0)) return "no arguments";
  const text = typeof detail === "string" ? detail : (JSON.stringify(detail, null, 1) ?? "");
  const lines = text.split("\n");
  if (lines.length <= SUMMARY.lines && text.length <= SUMMARY.chars) return text;
  const head = lines.slice(0, SUMMARY.lines / 2).join("\n");
  const tail = lines.slice(1 - SUMMARY.lines / 2).join("\n");
  return `${head.slice(0, SUMMARY.chars / 2)}\n…\n${tail.slice(-SUMMARY.chars / 2)}`;
}

export interface Question {
  /** Answer key: Codex uses an id, Claude the question text. */
  key: string;
  header: string;
  question: string;
  options: { label: string; description: string }[] | null;
  allowOther: boolean;
  secret: boolean;
  multi: boolean;
}

/** Codex `requestUserInput` and Claude `AskUserQuestion` ask in different shapes; the card is one. */
export function readQuestions(input: unknown): Question[] {
  const p = (input ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(p["questions"]) ? (p["questions"] as Record<string, unknown>[]) : [];
  return raw.map((q, i) => {
    const options = Array.isArray(q["options"]) ? (q["options"] as Record<string, unknown>[]).map((o) => ({ label: String(o["label"] ?? ""), description: String(o["description"] ?? "") })) : null;
    const question = String(q["question"] ?? "");
    return {
      key: typeof q["id"] === "string" ? q["id"] : question || String(i),
      header: String(q["header"] ?? ""),
      question,
      options: options && options.length > 0 ? options : null,
      allowOther: typeof q["allowOther"] === "boolean" ? q["allowOther"] || options === null : q["isOther"] === true || options === null || q["multiSelect"] === true,
      secret: q["isSecret"] === true,
      multi: q["multiSelect"] === true,
    };
  });
}

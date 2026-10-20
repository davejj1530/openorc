import { useState } from "react";
import { core } from "../lib/rpc";
import type { Block } from "../lib/transcript";
import { Hammer, Terminal, X } from "./icons";
import { Button, TextButton } from "./ui";

type ApprovalBlock = Extract<Block, { kind: "approval" }>;

/**
 * What the user actually needs to judge, per approval shape: the command for
 * shell approvals, the tool arguments for MCP calls, the tool input for
 * Claude's permission prompt. Raw params stay one click away.
 */
function approvalDetail(block: ApprovalBlock): unknown {
  const p = (block.input ?? {}) as Record<string, unknown>;
  if (typeof p["command"] === "string") return p["command"];
  const meta = p["_meta"] as Record<string, unknown> | undefined;
  if (meta && meta["tool_params"] !== undefined) return meta["tool_params"];
  if (p["permissions"] !== undefined) return p["permissions"];
  if (p["input"] !== undefined) return p["input"];
  return block.input;
}

export function summaryText(v: unknown): string {
  if (v === null || v === undefined) return "no arguments";
  if (typeof v === "object" && Object.keys(v as object).length === 0) return "no arguments";
  return pretty(v, 600);
}

export function pretty(v: unknown, max = 2000): string {
  const s = typeof v === "string" ? v : (JSON.stringify(v, null, 1) ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A refusal keeps one quiet line in the turn; an allowed call already shows as its tool row. */
function DeniedLine({ block, label }: { block: ApprovalBlock; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="approval-answer">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="approval-answer-row">
        <X size={16} className="text-bad shrink-0" />
        <span className="shrink-0">Denied</span>
        <span className="approval-answer-label">{label}</span>
      </button>
      {open ? <pre className="approval-answer-detail">{summaryText(approvalDetail(block))}</pre> : null}
    </div>
  );
}

/** The agent asks before it acts: what it wants to do, then Deny, Allow for this run and Allow. */
export function ApprovalCard({ block, runId }: { block: ApprovalBlock; runId: string }) {
  const decide = (decision: "allow" | "allow_for_run" | "deny") => void core.call("approvals.resolve", { runId, approvalId: block.approvalId, decision });
  const [raw, setRaw] = useState(false);
  const label = block.toolName ?? block.approvalKind;
  if (block.decision && block.decision !== "deny") return null;
  if (block.decision) return <DeniedLine block={block} label={label} />;
  const detail = approvalDetail(block);
  const Icon = typeof detail === "string" ? Terminal : Hammer;
  return (
    <div data-blocking="true" data-plane className="approval-card">
      <div className="approval-card-request">
        <span className="approval-card-well" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className="approval-card-words">
          <span className="approval-card-title">{block.reason ?? `Allow ${label}?`}</span>
          <pre className="approval-card-detail">{raw ? pretty(block.input, 800) : summaryText(detail)}</pre>
          <TextButton tone="faint" onClick={() => setRaw((v) => !v)} className="approval-card-raw">
            {raw ? "Summary" : "Raw request"}
          </TextButton>
        </div>
      </div>
      <div className="approval-card-actions">
        <Button size="lg" variant="secondary" onClick={() => decide("deny")}>
          Deny
        </Button>
        {block.onceOnly ? null : (
          <Button size="lg" variant="secondary" onClick={() => decide("allow_for_run")}>
            Allow for this run
          </Button>
        )}
        <Button size="lg" variant="primary" onClick={() => decide("allow")}>
          Allow
        </Button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { core } from "../lib/rpc";
import { approvalDetail, approvalSummary, type Block } from "@openorc/client";
import { Hammer, Terminal, X } from "./icons";
import { Button, TextButton } from "./ui";

type ApprovalBlock = Extract<Block, { kind: "approval" }>;

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
      {open ? <pre className="approval-answer-detail">{approvalSummary(block)}</pre> : null}
    </div>
  );
}

/** The foot's switch between the request as summed up, or nothing when a reason says it, and the raw request. */
function toggleLabel(raw: boolean, summed: boolean): string {
  if (raw) return summed ? "Summary" : "Hide request";
  return summed ? "Raw request" : "Show request";
}

/** What the card asks, in words: the agent's own reason when it gives one, else what the request does. */
function askFor(block: ApprovalBlock, label: string): string {
  if (block.reason) return block.reason;
  return typeof approvalDetail(block) === "string" ? "Run this command?" : `Allow ${label}?`;
}

/**
 * The agent asks before it acts, laid out as a question card is: what it asks, the request itself in a well the width
 * of the card, then a foot with the raw request on demand and Deny, Allow for this run and Allow.
 */
export function ApprovalCard({ block, runId }: { block: ApprovalBlock; runId: string }) {
  const decide = (decision: "allow" | "allow_for_run" | "deny") => void core.call("approvals.resolve", { runId, approvalId: block.approvalId, decision });
  const [raw, setRaw] = useState(false);
  const label = block.toolName ?? block.approvalKind;
  if (block.decision && block.decision !== "deny") return null;
  if (block.decision) return <DeniedLine block={block} label={label} />;
  const command = typeof approvalDetail(block) === "string";
  const Icon = command ? Terminal : Hammer;
  // A reason already says what a request does; its fields are there on demand. A command is always shown, to be read.
  const shown = raw || command || !block.reason;
  return (
    <div data-blocking="true" data-plane className="approval-card">
      <p className="approval-card-ask">
        <Icon size={14} className="approval-card-icon" aria-hidden="true" />
        <span>{askFor(block, label)}</span>
      </p>
      {shown ? (
        <pre className="approval-card-detail" data-raw={raw || undefined}>
          {raw ? pretty(block.input, 800) : approvalSummary(block)}
        </pre>
      ) : null}
      <div className="approval-card-foot">
        <span className="min-w-0 flex-1">
          <TextButton tone="faint" onClick={() => setRaw((v) => !v)} className="approval-card-raw">
            {toggleLabel(raw, command || !block.reason)}
          </TextButton>
        </span>
        <Button size="md" variant="ghost" onClick={() => decide("deny")}>
          Deny
        </Button>
        {block.onceOnly ? null : (
          <Button size="md" variant="secondary" onClick={() => decide("allow_for_run")}>
            Allow for this run
          </Button>
        )}
        <Button size="md" variant="primary" onClick={() => decide("allow")}>
          Allow
        </Button>
      </div>
    </div>
  );
}

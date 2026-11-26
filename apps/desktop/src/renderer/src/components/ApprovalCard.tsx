import { useContext, useState } from "react";
import { approvalDetail, approvalSummary, type Block, type WaitingAsk } from "@openorc/client";
import { Hammer, Terminal, X } from "./icons";
import { AskContinues, useAskAnswer } from "./ask-answer";
import { askKeyDown, AskError, AskFoot, AskLine, AskTop, AskWay } from "./AskParts";
import { Button } from "./ui";

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

/** What the ask asks, in words: the agent's own reason when it gives one, else what the request does. */
function askFor(block: ApprovalBlock, label: string): string {
  if (block.reason) return block.reason;
  return typeof approvalDetail(block) === "string" ? "Run this command?" : `Allow ${label}?`;
}

/**
 * An agent's request where it was asked. Allowed, it shows as its tool row and this draws nothing; denied, one quiet
 * line remembers it. While it waits where no composer takes it (a task's activity), it is the ask itself, as the
 * composer docks it.
 */
export function ApprovalCard({ block, runId }: { block: ApprovalBlock; runId: string }) {
  if (block.decision && block.decision !== "deny") return null;
  if (block.decision) return <DeniedLine block={block} label={block.toolName ?? block.approvalKind} />;
  return (
    <div data-blocking="true" data-plane className="question-card" onKeyDown={askKeyDown(() => {})}>
      <ApprovalAsk ask={{ runId, block }} more={0} fieldHasWords={false} />
    </div>
  );
}

/**
 * A request docked onto the composer while it waits: what it asks alone across the top, the request itself as the
 * agent sums it up (the raw request on demand when it says more), a line for what to do instead, and one row for Deny
 * and the allows. Allow once is the ask's one ink; words in its line make Deny and send the ink, and words in the field
 * below take it from both.
 */
export function ApprovalAsk({ ask, more, fieldHasWords }: { ask: WaitingAsk; more: number; fieldHasWords: boolean }) {
  const { block } = ask;
  const [raw, setRaw] = useState(false);
  const [note, setNote] = useState("");
  const reply = useAskAnswer(ask.runId, block.approvalId);
  // A parked ask of someone else's turn starts the reader's own paid turn, approved or with words instead; Deny is free.
  const continues = useContext(AskContinues)(block.approvalId);
  const label = block.toolName ?? block.approvalKind;
  const command = typeof approvalDetail(block) === "string";
  const Icon = command ? Terminal : Hammer;
  const off = reply.pending || Boolean(reply.blocked);
  const tip = reply.blocked ?? undefined;
  const noted = note.trim().length > 0;
  const allow = (decision: Allow) => ({ disabled: off, "data-tip": tip ?? continues ?? undefined, onClick: () => reply.answer(decision) });
  return (
    <>
      <AskTop mark={<Icon size={14} className="text-ink-3" aria-hidden="true" />}>{askFor(block, label)}</AskTop>
      <div className="composer-ask-body">
        <pre className="composer-ask-detail" data-raw={raw || undefined}>
          {raw ? pretty(block.input, 800) : approvalSummary(block)}
        </pre>
        <AskLine
          label={`What to do instead of ${label}`}
          placeholder="Say what to do instead"
          secret={false}
          value={note}
          onChange={setNote}
          send={
            noted ? { words: continues ? "Deny and continue" : "Deny and send", ink: !fieldHasWords, tip: continues ?? undefined, onSend: () => reply.answer("deny", undefined, note.trim()) } : null
          }
          disabled={off}
          tip={tip}
        />
      </div>
      <AskError error={reply.error} />
      <AskFoot
        more={more}
        ways={
          <>
            {command ? null : (
              <AskWay disabled={false} tip={undefined} onClick={() => setRaw((v) => !v)}>
                {raw ? "Hide request" : "Show request"}
              </AskWay>
            )}
            <AskWay disabled={off} tip={tip} onClick={() => reply.answer("deny")}>
              Deny
            </AskWay>
          </>
        }
      >
        <ApprovalWays onceOnly={Boolean(block.onceOnly)} continues={continues} ink={!(fieldHasWords || noted)} allow={allow} />
      </AskFoot>
    </>
  );
}

type Allow = "allow" | "allow_for_run";

/**
 * The approval's ways on: Allow for this run and Allow once, or, where the answer continues on the reader's own sign-in
 * and hours, Approve and continue alone. The row's ink unless words wait elsewhere.
 */
function ApprovalWays({
  onceOnly,
  continues,
  ink,
  allow,
}: {
  onceOnly: boolean;
  continues: string | null;
  ink: boolean;
  allow: (decision: Allow) => { disabled: boolean; "data-tip": string | undefined; onClick: () => void };
}) {
  return (
    <>
      {onceOnly || continues ? null : (
        <Button size="md" variant="secondary" className="focus-ring" tabIndex={-1} data-ask-control="action" {...allow("allow_for_run")}>
          Allow for this run
        </Button>
      )}
      <Button size="md" variant={ink ? "primary" : "secondary"} className="focus-ring" tabIndex={-1} data-ask-control="action" {...allow("allow")}>
        {continues ? "Approve and continue" : "Allow once"}
      </Button>
    </>
  );
}

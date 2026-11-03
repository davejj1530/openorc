import { useState } from "react";
import { subagentStatusLabel, useTicking, workDuration, type Block, type SubagentCard } from "@openorc/client";
import { openThread } from "../lib/router";
import { ChevronRight, CircleCheck, CircleDashed, Loader2, X } from "./icons";
import { IconButton } from "./ui";
import { useRpcs } from "../lib/client";

export function SubagentCards({ blocks }: { blocks: Extract<Block, { kind: "tool" }>[] }) {
  const [detail, setDetail] = useState<string | null>(null);
  const children = useRpcs(
    "threads.get",
    blocks.map((block) => ({ id: block.subagent?.threadId ?? "" })),
  );
  blocks = blocks.filter((_, index) => children[index]?.data !== null);
  const label = blocks[0]?.subagent?.group ?? (blocks.length > 1 ? `${blocks.length} agents` : null);
  if (!blocks.length) return null;
  return (
    <div className="subagent-cards" data-plane>
      {label ? <div className="subagent-group-label">{label}</div> : null}
      {blocks.map((block) => (block.subagent ? <SubagentRow key={block.id} card={block.subagent} open={detail === block.id} toggle={() => setDetail(detail === block.id ? null : block.id)} /> : null))}
    </div>
  );
}

function SubagentMark({ status }: { status: SubagentCard["status"] }) {
  if (status === "running") return <Loader2 size={15} className="tool-row-live" />;
  if (status === "no_updates") return <CircleDashed size={15} />;
  return status === "completed" ? <CircleCheck size={15} /> : <X size={15} />;
}

function SubagentRow({ card, open, toggle }: { card: SubagentCard; open: boolean; toggle(): void }) {
  const working = card.status === "running";
  const now = useTicking(working);
  return (
    <div className="subagent-card" data-status={card.status}>
      <div className="subagent-card-heading">
        <button className="subagent-card-link" onClick={() => openThread(card.threadId)} aria-label={`Open ${card.title}`}>
          <SubagentMark status={card.status} />
          <span className="subagent-card-name">{card.title}</span>
          {card.agentType ? <span className="subagent-card-meta">{card.agentType}</span> : null}
          <span className="subagent-card-meta">{subagentStatusLabel[card.status]}</span>
          <span className="subagent-card-meta tabular">{workDuration((card.endedAt ?? now) - card.startedAt)}</span>
        </button>
        <IconButton size="xs" aria-label={`Details for ${card.title}`} aria-expanded={open} onClick={toggle}>
          <ChevronRight size={13} className={open ? "work-chevron rotate-90" : "work-chevron"} />
        </IconButton>
      </div>
      {working && card.progress ? <div className="subagent-card-progress">{card.progress}</div> : null}
      {open ? (
        <div className="subagent-card-detail motion-arrive">
          {card.prompt ? <p className="whitespace-pre-wrap">{card.prompt}</p> : null}
          {card.result ? <p className="whitespace-pre-wrap">{card.result}</p> : null}
          {!card.prompt && !card.result ? <span className="text-ink-3">{subagentStatusLabel[card.status]}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

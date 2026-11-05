import { useState } from "react";
import { subagentStatusLabel, useTicking, workDuration, type Block, type SubagentCard } from "@openorc/client";
import { openThread } from "../lib/router";
import { ArrowUpRight, Check, ChevronRight, CircleDashed, Loader2, X } from "./icons";
import { IconButton } from "./ui";
import { useRpc, useRpcs } from "../lib/client";

/** "Sonnet 5.5" for a Claude model id the catalogue does not list; any other id as it is. */
const claudeName = (id: string) =>
  /^claude-[a-z]+(?:-\d+)+$/.test(id)
    ? id
        .replace(/^claude-/, "")
        .replace(/-(\d+)-(\d+)$/, " $1.$2")
        .replace(/-(\d+)$/, " $1")
        .replace(/^./, (c) => c.toUpperCase())
    : id;

/** The first sentence of what an agent came back with, for the line under its lane. */
const firstSentence = (text: string) =>
  text
    .trim()
    .split(/(?<=[.!?])\s/)[0]
    ?.replace(/[*_`#>]/g, "") ?? "";

/**
 * The agents a turn started, each a lane off one trunk: its mark, title, kind and model, how long it ran, and under
 * it what it is doing now or the first sentence of what it found. A lane opens its thread; the chevron shows its
 * prompt and its whole result.
 */
export function SubagentCards({ blocks }: { blocks: Extract<Block, { kind: "tool" }>[] }) {
  const [detail, setDetail] = useState<string | null>(null);
  const children = useRpcs(
    "threads.get",
    blocks.map((block) => ({ id: block.subagent?.threadId ?? "" })),
  );
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const cards = blocks.flatMap((block, index) => (block.subagent && children[index]?.data !== null ? [{ id: block.id, card: block.subagent }] : []));
  const working = cards.filter(({ card }) => card.status === "running").length;
  const done = cards.filter(({ card }) => card.status === "completed").length;
  const now = useTicking(working > 0);
  if (!cards.length) return null;
  const label = cards[0]!.card.group ?? (cards.length > 1 ? `${cards.length} agents` : null);
  const tally = [done ? `${done} done` : "", working ? `${working} working` : ""].filter(Boolean).join(" · ");
  const modelName = (id: string | undefined) => (id ? (models.data?.find((model) => model.id === id)?.label ?? claudeName(id)) : "");
  return (
    <div className="subagent-cards" data-plane>
      {label ? (
        <div className="subagent-group-label">
          <span>{label}</span>
          {cards.length > 1 && tally ? (
            <span className="subagent-tally motion-swap">
              <span key={tally} className="motion-arrive">
                {tally}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
      <ol className="subagent-lanes" data-trunk={cards.length > 1 || undefined}>
        {cards.map(({ id, card }) => (
          <SubagentLane key={id} card={card} model={modelName(card.model)} now={now} open={detail === id} toggle={() => setDetail(detail === id ? null : id)} />
        ))}
      </ol>
    </div>
  );
}

function SubagentMark({ status }: { status: SubagentCard["status"] }) {
  if (status === "running") return <Loader2 size={15} className="tool-row-live" />;
  if (status === "no_updates") return <CircleDashed size={15} />;
  if (status === "completed")
    return (
      <span className="step-check subagent-check">
        <Check size={10} strokeWidth={2.25} />
      </span>
    );
  return <X size={15} data-tone="bad" />;
}

function LaneHead({ card, model, now }: { card: SubagentCard; model: string; now: number }) {
  const quiet = card.status === "completed" || card.status === "running";
  return (
    <button className="subagent-card-link" onClick={() => openThread(card.threadId)} aria-label={`Open ${card.title}`}>
      <span className="subagent-card-mark">
        <SubagentMark status={card.status} />
      </span>
      <span className="subagent-card-name">{card.title}</span>
      <span className="subagent-card-meta subagent-card-kind">{[card.agentType, model].filter(Boolean).join(" · ")}</span>
      {quiet ? null : <span className="subagent-card-meta">{subagentStatusLabel[card.status]}</span>}
      <span className="subagent-card-meta tabular">{workDuration((card.endedAt ?? now) - card.startedAt)}</span>
      <ArrowUpRight size={13} className="subagent-card-open" />
    </button>
  );
}

function SubagentLane({ card, model, now, open, toggle }: { card: SubagentCard; model: string; now: number; open: boolean; toggle(): void }) {
  const working = card.status === "running";
  const result = card.result ? firstSentence(card.result) : undefined;
  const line = working ? card.progress : result;
  return (
    <li className="subagent-card" data-status={card.status}>
      <div className="subagent-card-heading">
        <LaneHead card={card} model={model} now={now} />
        <IconButton size="xs" aria-label={`Details for ${card.title}`} aria-expanded={open} onClick={toggle}>
          <ChevronRight size={13} className={open ? "work-chevron rotate-90" : "work-chevron"} />
        </IconButton>
      </div>
      {line && !open ? (
        <div className="subagent-card-progress motion-swap" data-live={working || undefined}>
          <span key={line} className={working ? "motion-arrive" : undefined}>
            {line}
          </span>
        </div>
      ) : null}
      {open ? <LaneDetail card={card} /> : null}
    </li>
  );
}

function LaneDetail({ card }: { card: SubagentCard }) {
  return (
    <div className="subagent-card-detail motion-arrive">
      {card.prompt ? <p className="whitespace-pre-wrap">{card.prompt}</p> : null}
      {card.result ? <p className="whitespace-pre-wrap">{card.result}</p> : null}
      {!card.prompt && !card.result ? <span className="text-ink-3">{subagentStatusLabel[card.status]}</span> : null}
    </div>
  );
}

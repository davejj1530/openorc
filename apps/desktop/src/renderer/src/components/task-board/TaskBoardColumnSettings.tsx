import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import type { AccountsProject } from "@openorc/client";
import type { BoardStage, ThreadChoice } from "@openorc/protocol";
import { CoversPreview } from "../../lib/browser-preview";
import type { BoardSlot } from "../../lib/task-board";
import { floatingGround } from "../../lib/use-anchor-ground";
import { AgentBrief } from "../AgentBrief";
import { ArrowLeft, ArrowRight, MoreHorizontal } from "../icons";
import { Segmented } from "../Segmented";
import { IconButton, Input, Select, TextButton, Tooltip } from "../ui";

/** What a column's cards are to the app, in the person's words. The stage decides what counts as waiting on them and what is finished. */
const stages: readonly { value: BoardStage; label: string }[] = [
  { value: "backlog", label: "Waiting" },
  { value: "in_progress", label: "Working" },
  { value: "review", label: "Needs you" },
  { value: "done", label: "Finished" },
];

/**
 * What the column has an agent do with each card: the words it is told, written as a message would be, with the model
 * that reads them at the box's foot. The words save when the box is left, and a box left empty starts nothing.
 */
function ColumnAgent({ slot, project, shared, onChange }: { slot: BoardSlot; project: AccountsProject | undefined; shared: boolean; onChange: (patch: Partial<BoardSlot>) => void }) {
  const [words, setWords] = useState(slot.job?.prompt ?? "");
  const [choice, setChoice] = useState<ThreadChoice | null>(slot.job?.choice ?? null);
  const save = (prompt: string, model: ThreadChoice | null) => {
    const job = prompt.trim() ? { prompt: prompt.trim(), choice: model } : null;
    if (JSON.stringify(job) !== JSON.stringify(slot.job ?? null)) onChange(job ? { job } : { job: null, nextColumnId: null });
  };
  return (
    <AgentBrief
      words={words}
      onWords={setWords}
      onLeave={() => save(words, choice)}
      choice={choice}
      onChoice={(next) => {
        setChoice(next);
        save(words, next);
      }}
      project={project}
      sameLabel="The task's model"
      placeholder="Tell an agent what to do with each card"
      // A shared board's agent runs on each assignee's own account, so no account of this computer's is offered.
      offerAccounts={!shared}
    />
  );
}

/**
 * A column of the board of all projects, across them: the projects that have it, none when every one does, and those
 * whose agent is told other words than the one shown. A change here is made in each of them.
 */
export type ColumnAcross = { having: string[] | null; agentDiffers: string[]; sole: boolean };

const listed = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

type FootProps = { slots: readonly BoardSlot[]; index: number; across: ColumnAcross | null; onChange: (slots: BoardSlot[], open: number | null) => void };

/**
 * The settings' foot: the column's moves, or on the board of all projects the projects that have it, and its removal,
 * which a board's only column, or some project's, cannot take.
 */
function SettingsFoot({ slots, index, across, onChange }: FootProps) {
  const moveTo = (place: number) => {
    const next = [...slots];
    next.splice(place, 0, ...next.splice(index, 1));
    onChange(next, place);
  };
  return (
    <div className="task-board-settings-foot">
      {across ? (
        <p className="task-board-settings-where">{across.having ? `In ${listed.format(across.having)}` : "In every project"}</p>
      ) : (
        <>
          <Tooltip label="Move left">
            <IconButton size="sm" aria-label="Move left" disabled={index === 0} onClick={() => moveTo(index - 1)}>
              <ArrowLeft size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip label="Move right">
            <IconButton size="sm" aria-label="Move right" disabled={index === slots.length - 1} onClick={() => moveTo(index + 1)}>
              <ArrowRight size={15} />
            </IconButton>
          </Tooltip>
        </>
      )}
      <TextButton
        className="task-board-remove"
        disabled={slots.length === 1 || Boolean(across?.sole)}
        onClick={() =>
          onChange(
            slots.filter((_, place) => place !== index),
            null,
          )
        }
      >
        Remove column
      </TextButton>
    </div>
  );
}

/**
 * One column's settings, opened from its head: its name, its stage, the agent a card starts there and where the card
 * goes when that agent is done, its place and its removal. Every change saves the whole board, and `onChange` names the
 * place whose settings stay open after it. On the board of all projects, `across` says where the column is, and its
 * place follows its stage there, so it has no moves.
 */
export function TaskBoardColumnSettings({
  slots,
  index,
  project,
  jobsStart,
  shared,
  across,
  open,
  onOpenChange,
  onChange,
}: {
  slots: readonly BoardSlot[];
  index: number;
  project: AccountsProject | undefined;
  /** Whether a column here can have an agent: a board this computer keeps. An organization's board is its columns alone. */
  jobsStart: boolean;
  /** Whether the board is an organization's, whose agents run on each task's assignee's computer. */
  shared: boolean;
  across: ColumnAcross | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (slots: BoardSlot[], open: number | null) => void;
}) {
  const slot = slots[index]!;
  const later = slots.slice(index + 1).filter((each) => each.id);
  const put = (patch: Partial<BoardSlot>) =>
    onChange(
      slots.map((each, place) => (place === index ? { ...each, ...patch } : each)),
      index,
    );
  const rename = (value: string) => {
    const name = value.trim();
    if (name && name !== slot.name) put({ name });
  };
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={<IconButton size="xs" className="task-board-column-more" aria-label={`${slot.name} settings`} />}>
        <MoreHorizontal size={15} />
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-40">
          <Popover.Popup ref={floatingGround} className="floating-popover task-board-settings" aria-label={`${slot.name} settings`}>
            <Input
              key={slot.name}
              className="task-board-settings-name"
              aria-label="Column name"
              defaultValue={slot.name}
              maxLength={40}
              onBlur={(event) => rename(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <Segmented size="sm" label="Stage" value={slot.stage} options={stages} onChange={(stage) => put({ stage })} />
            {jobsStart ? (
              <section className="task-board-setting" aria-labelledby={`column-${index}-arrives`}>
                <h3 id={`column-${index}-arrives`} className="task-board-setting-label">
                  When a card arrives
                </h3>
                <ColumnAgent key={slot.id ?? index} slot={slot} project={project} shared={shared} onChange={put} />
                {across && across.agentDiffers.length > 0 ? (
                  <p className="task-board-setting-note">Its agent is told something else in {listed.format(across.agentDiffers)}. A change here sets it in every project.</p>
                ) : null}
              </section>
            ) : null}
            {jobsStart && slot.job ? (
              <label className="task-board-setting task-board-setting-row">
                <span className="task-board-setting-label">When the work is done</span>
                <Select value={later.some((each) => each.id === slot.nextColumnId) ? (slot.nextColumnId ?? "") : ""} onChange={(event) => put({ nextColumnId: event.currentTarget.value || null })}>
                  <option value="">The card stays here</option>
                  {later.map((each) => (
                    <option key={each.id} value={each.id}>
                      Move to {each.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            <SettingsFoot slots={slots} index={index} across={across} onChange={onChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

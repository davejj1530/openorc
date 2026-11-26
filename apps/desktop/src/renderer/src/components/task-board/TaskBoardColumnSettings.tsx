import { Popover } from "@base-ui/react/popover";
import type { BoardStage } from "@openorc/protocol";
import { CoversPreview } from "../../lib/browser-preview";
import type { BoardSlot } from "../../lib/task-board";
import { floatingGround } from "../../lib/use-anchor-ground";
import { ArrowLeft, ArrowRight, MoreHorizontal } from "../icons";
import { Segmented } from "../Segmented";
import { Button, Field, IconButton, Input } from "../ui";

/** What a column's cards are to the app, in the person's words. The stage decides what counts as waiting on them and what is finished. */
const stages: readonly { value: BoardStage; label: string }[] = [
  { value: "backlog", label: "Waiting" },
  { value: "in_progress", label: "Working" },
  { value: "review", label: "Needs you" },
  { value: "done", label: "Finished" },
];

/**
 * One column's settings, opened from its head: its name, its stage, its place and its removal. Every change saves the
 * whole board, and `onChange` names the place whose settings stay open after it.
 */
export function TaskBoardColumnSettings({
  slots,
  index,
  open,
  onOpenChange,
  onChange,
}: {
  slots: readonly BoardSlot[];
  index: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (slots: BoardSlot[], open: number | null) => void;
}) {
  const slot = slots[index]!;
  const put = (patch: Partial<BoardSlot>) =>
    onChange(
      slots.map((each, place) => (place === index ? { ...each, ...patch } : each)),
      index,
    );
  const moveTo = (place: number) => {
    const next = [...slots];
    next.splice(place, 0, ...next.splice(index, 1));
    onChange(next, place);
  };
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
            <Field label="Name">
              <Input
                key={slot.name}
                defaultValue={slot.name}
                maxLength={40}
                onBlur={(event) => rename(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </Field>
            <div className="task-board-setting">
              <span className="text-sm text-ink-3">Stage</span>
              <Segmented size="sm" label="Stage" value={slot.stage} options={stages} onChange={(stage) => put({ stage })} />
            </div>
            <div className="task-board-settings-row">
              <Button size="sm" disabled={index === 0} onClick={() => moveTo(index - 1)}>
                <ArrowLeft size={13} />
                Move left
              </Button>
              <Button size="sm" disabled={index === slots.length - 1} onClick={() => moveTo(index + 1)}>
                Move right
                <ArrowRight size={13} />
              </Button>
            </div>
            <button
              type="button"
              className="task-board-remove"
              disabled={slots.length === 1}
              onClick={() =>
                onChange(
                  slots.filter((_, place) => place !== index),
                  null,
                )
              }
            >
              Remove column
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

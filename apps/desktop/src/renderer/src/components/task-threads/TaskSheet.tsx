import { useState, type ReactElement, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { CoversPreview } from "../../lib/browser-preview";
import { floatingGround } from "../../lib/use-anchor-ground";
import { growOffset } from "../menu";
import { Button } from "../ui";
import "./task-threads.css";

/**
 * A task sheet's open state and its confirm. Pending from the first press, so a second one while the task saves can't
 * start the work again; done closes the sheet, and a failure stays open saying why.
 */
export function useTaskSheet(onOpen?: () => void) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setError(null);
    onOpen?.();
  };
  return { open, pending, error, run, onOpenChange, close: () => setOpen(false) };
}

type TaskSheetState = ReturnType<typeof useTaskSheet>;

type Props = {
  sheet: TaskSheetState;
  title: string;
  trigger: ReactElement;
  side: "top" | "bottom";
  align: "start" | "end";
  confirm: string;
  pendingLabel: string;
  ready: boolean;
  /** Resolves once the work has started, or throws to say why it couldn't. */
  onConfirm: () => Promise<void>;
  children: ReactNode;
};

export function TaskSheet({ sheet, title, trigger, side, align, confirm, pendingLabel, ready, onConfirm, children }: Props) {
  return (
    <Popover.Root open={sheet.open} onOpenChange={sheet.onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side={side} align={align} sideOffset={growOffset} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} data-plane className="task-sheet">
            <Popover.Title className="task-sheet-title">{title}</Popover.Title>
            {children}
            {sheet.error ? (
              <p role="alert" className="text-sm text-bad">
                {sheet.error}
              </p>
            ) : null}
            <div className="task-sheet-actions">
              <Button size="hero" disabled={sheet.pending} onClick={sheet.close}>
                Cancel
              </Button>
              <Button size="hero" variant="primary" className="flex-1" disabled={!ready || sheet.pending} onClick={() => void sheet.run(onConfirm)}>
                {sheet.pending ? pendingLabel : confirm}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

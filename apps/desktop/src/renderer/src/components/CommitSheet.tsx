import type { ReactElement, ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button, Textarea } from "./ui";
import { growOffset } from "./menu";
import { floatingGround } from "../lib/use-anchor-ground";
import { CoversPreview } from "../lib/browser-preview";
import "./CommitSheet.css";

/**
 * The commit form as an r22 sheet that grows out of its Commit pill: a title with what is being
 * committed, the message, any notices or errors, then Cancel and Commit. Opening it from
 * elsewhere (the composer's commit chip) grows it from the same pill.
 */
export function CommitSheet({
  open,
  onOpenChange,
  trigger,
  title,
  summary,
  message,
  onMessageChange,
  busy,
  commitDisabled,
  committing,
  onCommit,
  placeholder,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Commit pill the sheet grows out of. */
  trigger: ReactElement;
  title: string;
  summary?: ReactNode;
  message: string;
  onMessageChange: (message: string) => void;
  busy: boolean;
  commitDisabled: boolean;
  committing: boolean;
  onCommit: () => void;
  placeholder?: string;
  /** Notices and errors between the message and the actions. */
  children?: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} className="commit-sheet-pill" />
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="bottom" align="end" sideOffset={growOffset} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} data-plane className="commit-sheet">
            <div className="commit-sheet-head commit-sheet-part">
              <Popover.Title className="commit-sheet-title">{title}</Popover.Title>
              {summary ? <div className="commit-sheet-summary">{summary}</div> : null}
            </div>
            <div className="commit-sheet-part">
              <Textarea
                variant="sheet"
                rows={1}
                aria-label="Message"
                className="commit-sheet-message"
                value={message}
                onChange={(e) => onMessageChange(e.target.value)}
                disabled={busy}
                autoFocus
                placeholder={placeholder ?? "Message"}
              />
              {children}
            </div>
            <div className="commit-sheet-actions commit-sheet-part">
              <Button size="hero" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="hero" variant="primary" className="flex-1" disabled={commitDisabled} onClick={onCommit}>
                {committing ? "Committing…" : "Commit"}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

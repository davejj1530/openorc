import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { floatingGround } from "../lib/use-anchor-ground";

/** Keep suggestions outside scrolling columns, without moving focus out of the textarea. */
export function ComposerSuggestions({
  anchor,
  side,
  members,
  cursor,
  count,
  onDismiss,
  children,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  side: "top" | "bottom";
  members: boolean;
  cursor: number;
  /** How many rows are offered: when that changes, the list may have moved out from under the selected row. */
  count: number;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = popup.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    // A row first under its heading brings the heading into view with it.
    const heading = row?.previousElementSibling?.classList.contains("composer-suggestion-group") ? row.previousElementSibling : null;
    heading?.scrollIntoView?.({ block: "nearest" });
    row?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, count]);
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner
          anchor={anchor}
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          positionMethod="fixed"
          className="z-40"
          style={{ width: members ? undefined : "var(--anchor-width)", maxWidth: "var(--available-width)" }}
        >
          <Popover.Popup
            ref={(element) => {
              popup.current = element;
              floatingGround(element);
            }}
            initialFocus={false}
            finalFocus={false}
            // Pressing the scrollbar or the padding must not blur the textarea, which would close the list.
            onMouseDown={(e) => e.preventDefault()}
            className={cn("composer-suggestions floating-popover", members && "min-w-56 max-w-full")}
            style={{ maxHeight: "min(320px, var(--available-height))" }}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

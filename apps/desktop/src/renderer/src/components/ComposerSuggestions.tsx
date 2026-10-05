import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";

/** Keep suggestions outside scrolling columns, without moving focus out of the textarea. */
export function ComposerSuggestions({
  anchor,
  side,
  members,
  cursor,
  children,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  side: "top" | "bottom";
  members: boolean;
  cursor: number;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    popup.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);
  return (
    <Popover.Root open modal={false}>
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
            ref={popup}
            initialFocus={false}
            finalFocus={false}
            className={cn("composer-suggestions rounded-lg border border-line bg-surface p-1 overflow-y-auto", members && "min-w-56 max-w-full")}
            style={{ maxHeight: "min(320px, var(--available-height))" }}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

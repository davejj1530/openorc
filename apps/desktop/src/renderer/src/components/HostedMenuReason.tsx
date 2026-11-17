import type { ReactNode } from "react";
import type { MenuParts } from "./ThreadActions";
import { menuItem } from "./menu";
import { Tooltip } from "./ui";

/**
 * Menu items remain in the arrow-key path while disabled, so the same trigger can explain why. The reason opens beside
 * the menu, never over a neighbouring row, and on its other side where the window has no room.
 */
export function HostedMenuReason({ parts: M, reason, children }: { parts: MenuParts; reason: string; children: ReactNode }) {
  return (
    <Tooltip label={reason} side="left" positionerClassName="z-50" render={<M.Item className={menuItem} disabled closeOnClick={false} />}>
      {children}
    </Tooltip>
  );
}

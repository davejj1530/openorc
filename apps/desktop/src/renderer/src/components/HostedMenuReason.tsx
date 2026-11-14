import type { ReactNode } from "react";
import type { MenuParts } from "./ThreadActions";
import { menuItem } from "./menu";
import { Tooltip } from "./ui";

/** Menu items remain in the arrow-key path while disabled, so the same trigger can explain why. */
export function HostedMenuReason({ parts: M, reason, children }: { parts: MenuParts; reason: string; children: ReactNode }) {
  return (
    <Tooltip label={reason} render={<M.Item className={menuItem} disabled closeOnClick={false} />}>
      {children}
    </Tooltip>
  );
}

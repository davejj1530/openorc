import type { ReactNode } from "react";
import { Tooltip } from "./ui";
import "../dialogs/received-invitations.css";

export function InvitationIndicator({ count, children }: { count: number; children: ReactNode }) {
  return (
    <Tooltip label={count ? `${count} invitation${count === 1 ? "" : "s"} waiting` : undefined}>
      <span className="organization-invitation-mark">
        {children}
        {count ? <span className="organization-invitation-dot" aria-label={`${count} invitation${count === 1 ? "" : "s"} waiting`} /> : null}
      </span>
    </Tooltip>
  );
}

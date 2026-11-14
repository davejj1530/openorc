import type { ReactNode } from "react";
import { Tooltip } from "./ui";
import "../dialogs/received-invitations.css";

/** One neutral dot for whatever waits in another space: invitations, and unread chat named by its organizations. */
export function InvitationIndicator({ count, chats = [], children }: { count: number; chats?: readonly string[]; children: ReactNode }) {
  const words = [count ? `${count} invitation${count === 1 ? "" : "s"} waiting` : "", chats.length ? `Unread chat in ${chats.join(", ")}` : ""].filter(Boolean).join(". ");
  if (!words) return <span className="organization-invitation-mark">{children}</span>;
  return (
    <Tooltip label={words}>
      <span className="organization-invitation-mark">
        {children}
        <span className="organization-invitation-dot" aria-label={words} />
      </span>
    </Tooltip>
  );
}

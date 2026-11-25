import type { ReactNode } from "react";
import { Tooltip } from "./ui";
import "../dialogs/received-invitations.css";

/**
 * One neutral dot for whatever waits: invitations, unread chat in another space, an unread mention in any space,
 * the open one too, each named by its organizations, and Orclings' chats while the list shows something else.
 */
export function InvitationIndicator({
  count,
  chats = [],
  mentions = [],
  orclings = 0,
  children,
}: {
  count: number;
  chats?: readonly string[];
  mentions?: readonly string[];
  orclings?: number;
  children: ReactNode;
}) {
  const words = [
    count ? `${count} invitation${count === 1 ? "" : "s"} waiting` : "",
    chats.length ? `Unread chat in ${chats.join(", ")}` : "",
    mentions.length ? `Unread mention in ${mentions.join(", ")}` : "",
    orclings ? `${orclings} Orcling${orclings === 1 ? "" : "s"} waiting` : "",
  ]
    .filter(Boolean)
    .join(". ");
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

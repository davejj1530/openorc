import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { OrganizationSeat } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { seatActionReason, useSeatAdministration } from "../lib/seat-administration";
import { IconButton } from "../components/ui";
import { MoreHorizontal } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { RevokeInvitationDialog } from "../dialogs/RevokeInvitationDialog";
import { cn } from "../lib/cn";
import { SeatMenuAction } from "./PersonSeatActions";

type Held = Extract<OrganizationSeat["assignment"], { kind: "invitation" }>;

/** What an admin can do with one seat: give a free one, move or take back a person's, or revoke the invitation holding it. */
export function SeatInventoryActions({ seat }: { seat: OrganizationSeat }) {
  const admin = useSeatAdministration();
  const [revoking, setRevoking] = useState<Held | null>(null);
  if (!admin?.permitted) return null;
  const assignment = seat.assignment;
  const actions = assignment.kind === "available" ? (["give"] as const) : (["move", "takeBack"] as const);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<IconButton aria-label="Seat actions" size="xs" />}>
          <MoreHorizontal size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-40">
            <Menu.Popup ref={floatingGround} className={cn(menuPopup, "people-member-menu")}>
              {assignment.kind === "invitation" ? (
                <Menu.Item className={menuItem} onClick={() => setRevoking(assignment)}>
                  Revoke invitation…
                </Menu.Item>
              ) : (
                actions.map((action) => <SeatMenuAction key={action} admin={admin} action={action} seatId={seat.id} short reason={seatActionReason(admin, action, seat)} />)
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {revoking ? <RevokeInvitationDialog spaceId={admin.scope.spaceId} invitationId={revoking.invitationId} email={revoking.email} onClose={() => setRevoking(null)} /> : null}
    </>
  );
}

import { Menu } from "@base-ui/react/menu";
import type { OrganizationSeat } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { seatActionReason, useSeatAdministration } from "../lib/seat-administration";
import { IconButton } from "../components/ui";
import { MoreHorizontal } from "../components/icons";
import { menuPopup } from "../components/menu";
import { cn } from "../lib/cn";
import { SeatMenuAction } from "./PersonSeatActions";

export function SeatInventoryActions({ seat }: { seat: OrganizationSeat }) {
  const admin = useSeatAdministration();
  if (!admin?.permitted || seat.assignment.kind === "invitation") return null;
  const actions = seat.assignment.kind === "available" ? (["give"] as const) : (["move", "takeBack"] as const);
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label="Seat actions" size="xs" />}>
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "people-member-menu")}>
            {actions.map((action) => (
              <SeatMenuAction key={action} admin={admin} action={action} seatId={seat.id} short reason={seatActionReason(admin, action, seat)} />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

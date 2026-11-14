import { Menu } from "@base-ui/react/menu";
import type { OrganizationPerson } from "@openorc/protocol";
import { menuItem } from "../components/menu";
import { TeamChatPersonMenu, type TeamChatPersonMenuProps } from "../components/TeamChatPersonMenu";
import { chooseAvailableSeat } from "../lib/seat-choice";
import { personSeat, seatActionReason, useSeatAdministration, type SeatAction, type SeatAdministration } from "../lib/seat-administration";

export function PersonSeatMenu({ self, ...props }: TeamChatPersonMenuProps & { self: boolean }) {
  const admin = useSeatAdministration();
  const extra = admin?.permitted && props.person.seat ? <PersonSeatActions admin={admin} person={props.person} /> : null;
  if (self && !extra) return null;
  return <TeamChatPersonMenu {...props} editable={!self && props.editable} extra={extra} />;
}

function PersonSeatActions({ admin, person }: { admin: SeatAdministration; person: OrganizationPerson }) {
  const held = personSeat(admin, person);
  if (person.seat?.id)
    return (
      <>
        {(["move", "takeBack"] as const).map((action) => (
          <SeatMenuAction key={action} action={action} admin={admin} seatId={held?.id} reason={held ? seatActionReason(admin, action, held) : "Read the seats again."} />
        ))}
      </>
    );
  const pending = new Set(admin.state.status?.assignments?.filter((work) => !work.operation || work.operation.state === "pending").map((work) => work.request.seatId));
  const choice = chooseAvailableSeat(admin.state.status?.billing?.seats.filter((seat) => !pending.has(seat.id)) ?? []);
  const choiceReason = { unknown: "Read the seats again.", empty: "No seats are available.", ready: null };
  const reason = seatActionReason(admin, "give") ?? choiceReason[choice.state];
  return <SeatMenuAction action="give" admin={admin} seatId={choice.state === "ready" ? choice.seat.id : undefined} memberId={person.memberId} reason={reason} />;
}

export function SeatMenuAction({
  action,
  admin,
  seatId,
  memberId,
  reason,
  short = false,
}: {
  action: SeatAction;
  admin: SeatAdministration;
  seatId?: string;
  memberId?: string;
  reason: string | null;
  short?: boolean;
}) {
  const words = { give: short ? "Give…" : "Give seat…", move: short ? "Move…" : "Move seat…", takeBack: short ? "Take back…" : "Take back seat…" };
  return (
    <Menu.Item
      className={menuItem}
      disabled={Boolean(reason)}
      data-tip={reason ?? undefined}
      onClick={() => {
        if (seatId && !reason) admin.open({ action, seatId, memberId: action === "takeBack" ? null : memberId });
      }}
    >
      {words[action]}
    </Menu.Item>
  );
}

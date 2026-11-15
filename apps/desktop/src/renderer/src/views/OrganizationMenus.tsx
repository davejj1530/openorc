import { useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import type { OrganizationPeople } from "@openorc/protocol";
import { ArrowLeft, MoreHorizontal, Pencil, Trash2 } from "../components/icons";
import { IconButton } from "../components/ui";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "../components/menu";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";

export function OrganizationMoreMenu({
  people,
  disabled,
  onAction,
}: {
  people: OrganizationPeople;
  disabled: boolean;
  onAction(action: "edit" | "leave" | "delete", trigger: HTMLButtonElement | null): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const admin = people.viewer.role === "admin";
  const onlyAdmin = admin && people.adminCount === 1;
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} render={<IconButton aria-label={`More for ${people.organization.name}`} />}>
        <MoreHorizontal size={17} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={8} align="end" collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={`${menuPopup} people-organization-menu`}>
            {admin ? (
              <Menu.Item className={menuItem} disabled={disabled} onClick={() => onAction("edit", trigger.current)}>
                <Pencil size={14} />
                Edit organization…
              </Menu.Item>
            ) : null}
            <LeaveAction disabled={disabled || onlyAdmin} onlyAdmin={onlyAdmin} onClick={() => onAction("leave", trigger.current)} />
            {admin ? (
              <>
                <Menu.Separator className={menuSeparator} />
                <Menu.Item className={menuItemDanger} disabled={disabled} onClick={() => onAction("delete", trigger.current)}>
                  <Trash2 size={14} />
                  Delete organization…
                </Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The organization page's "…" for someone whose access is frozen: leaving is all it holds. */
export function OrganizationLeaveMenu({ name, onLeave }: { name: string; onLeave(trigger: HTMLButtonElement | null): void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} render={<IconButton aria-label={`More for ${name}`} />}>
        <MoreHorizontal size={17} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={8} align="end" collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={`${menuPopup} people-organization-menu`}>
            <LeaveAction disabled={false} onlyAdmin={false} onClick={() => onLeave(trigger.current)} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function LeaveAction({ disabled, onlyAdmin, onClick }: { disabled: boolean; onlyAdmin: boolean; onClick(): void }) {
  const content = (
    <>
      <ArrowLeft size={14} />
      Leave organization…
    </>
  );
  if (!onlyAdmin)
    return (
      <Menu.Item className={menuItem} disabled={disabled} onClick={onClick}>
        {content}
      </Menu.Item>
    );
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<Menu.Item className={menuItem} disabled onClick={onClick} />}>{content}</Tooltip.Trigger>
      <Tooltip.Portal>
        <CoversPreview />
        <Tooltip.Positioner className="z-50" sideOffset={6}>
          <Tooltip.Popup ref={floatingGround} className="tooltip-popup">
            Make someone else an admin first.
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

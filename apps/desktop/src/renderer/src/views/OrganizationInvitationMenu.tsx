import { useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import { Copy, MoreHorizontal, RefreshCw, X } from "../components/icons";
import { IconButton } from "../components/ui";
import { menuItem, menuItemDanger, menuPopup } from "../components/menu";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";

export function OrganizationInvitationMenu({
  email,
  disabled,
  resendDisabled,
  resendReason,
  offerResend,
  copy,
  resend,
  revoke,
}: {
  email: string;
  disabled: boolean;
  resendDisabled: boolean;
  resendReason?: string;
  offerResend: boolean;
  copy(): void;
  resend(): void;
  revoke(trigger: HTMLButtonElement | null): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} render={<IconButton size="xs" aria-label={`More for invitation to ${email}`} />} disabled={disabled}>
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={4} align="end" collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={`${menuPopup} people-member-menu`}>
            <Menu.Item className={menuItem} onClick={copy}>
              <Copy size={14} />
              Copy link
            </Menu.Item>
            {offerResend ? <ResendItem disabled={resendDisabled} reason={resendReason} onClick={resend} /> : null}
            <Menu.Item className={menuItemDanger} onClick={() => revoke(trigger.current)}>
              <X size={14} />
              Revoke invitation…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ResendItem({ disabled, reason, onClick }: { disabled: boolean; reason: string | undefined; onClick(): void }) {
  const content = (
    <>
      <RefreshCw size={14} />
      Resend
    </>
  );
  if (!reason)
    return (
      <Menu.Item className={menuItem} disabled={disabled} onClick={onClick}>
        {content}
      </Menu.Item>
    );
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<Menu.Item className={menuItem} disabled={disabled} onClick={onClick} />}>{content}</Tooltip.Trigger>
      <Tooltip.Portal>
        <CoversPreview />
        <Tooltip.Positioner className="z-50" sideOffset={6}>
          <Tooltip.Popup ref={floatingGround} className="tooltip-popup">
            {reason}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

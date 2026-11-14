import { Menu } from "@base-ui/react/menu";
import type { OrganizationRole } from "@openorc/protocol";
import { Check, ChevronDown } from "../components/icons";
import { Button } from "../components/ui";
import { menuItem, menuPopup } from "../components/menu";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";

export function OrganizationInviteRole({ role, disabled, onChange }: { role: OrganizationRole; disabled: boolean; onChange(role: OrganizationRole): void }) {
  return (
    <div className="organization-invite-role">
      <span>Role</span>
      <Menu.Root>
        <Menu.Trigger render={<Button />} aria-label="Invitation role" disabled={disabled}>
          {role === "admin" ? "Admin" : "Member"}
          <ChevronDown size={13} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-50">
            <Menu.Popup ref={floatingGround} className={`${menuPopup} organization-invite-role-menu`}>
              {(["member", "admin"] as const).map((value) => (
                <Menu.Item key={value} className={menuItem} onClick={() => onChange(value)}>
                  {role === value ? <Check size={13} /> : <span className="organization-invite-check" />}
                  {value === "admin" ? "Admin" : "Member"}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

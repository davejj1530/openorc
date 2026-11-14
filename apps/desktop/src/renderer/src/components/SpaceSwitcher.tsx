import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { useOrganization } from "../lib/organization-context";
import { useSpaceLabel } from "../lib/space-label";
import { ChevronsUpDown } from "./icons";
import { OpenOrcMark } from "./OpenOrcMark";
import { OrganizationMark } from "./OrganizationMark";
import { InvitationIndicator } from "./InvitationIndicator";
import { SpaceMenu } from "./SpaceMenu";
import { menuPopup } from "./menu";
import { cn } from "../lib/cn";
import "./space-switcher.css";

export function SpaceSwitcher({ fallback = null, hidden = false }: { fallback?: ReactNode; hidden?: boolean }) {
  const actions = useOrganization();
  const [open, setOpen] = useState(false);
  const organization = actions?.organization;
  const label = organization?.name ?? "OpenOrc";
  const fit = useSpaceLabel(label, actions?.signedIn === true);
  if (!actions?.signedIn) return fallback;
  const count = actions.status?.state === "ready" ? actions.status.invitations.length : 0;
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        ref={fit.button}
        className={cn("space-switcher no-drag", hidden && "space-switcher-hidden")}
        aria-label={`Switch space, ${label}${count ? `, ${count} invitation${count === 1 ? "" : "s"}` : ""}`}
        data-tip={fit.clipped ? label : undefined}
      >
        <InvitationIndicator count={count}>{organization ? <OrganizationMark {...organization} /> : <OpenOrcMark size={16} />}</InvitationIndicator>
        <span className="space-switcher-name">
          {label.split(/\s+/).map((word, index) => (
            <span key={index}>
              {index ? " " : ""}
              {word}
            </span>
          ))}
        </span>
        <ChevronsUpDown size={10} className="space-switcher-chevron" />
        <span ref={fit.measure} className="space-switcher-measure" aria-hidden="true">
          {label}
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="start" alignOffset={-3} sideOffset={3} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "space-menu")}>
            <SpaceMenu actions={actions} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

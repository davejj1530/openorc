import { useId } from "react";
import { createPortal } from "react-dom";
import { Menu } from "@base-ui/react/menu";
import { CoversPreview } from "../lib/browser-preview";
import { Check, ChevronDown, Workflow } from "./icons";
import { menuItem, menuPopup } from "./ThreadActions";
import { Button } from "./ui";

/** Team details are available from the toolbar without adding another header. */
export function TeamConversationTools({
  target,
  name,
  version,
  status,
  working,
  showActivity,
  onShowActivity,
  compact,
}: {
  target?: HTMLElement | null | undefined;
  name: string;
  version: number;
  status: string;
  working: string | null;
  showActivity: boolean;
  onShowActivity: (show: boolean) => void;
  compact: { label: string; description: string; disabled: boolean; pending: boolean; run: () => void } | null;
}) {
  const descriptionId = useId();
  const label = compact?.pending ? compact.label : status;
  const menu = (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" variant="ghost" className="team-toolbar-trigger" aria-label={`Team controls: ${label}`} title={`${name} · ${label}`} />}>
        <Workflow size={14} />
        <span className="team-toolbar-status" role="status">
          {label}
        </span>
        <ChevronDown size={11} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup className={`${menuPopup} team-tools-menu`}>
            <div className="team-tools-summary">
              <strong>{name}</strong>
              <span>
                Version {version} · {status}
              </span>
              {working ? <span data-team-working>{working}</span> : null}
            </div>
            <Menu.Separator className="my-1 border-t border-line" />
            <Menu.CheckboxItem className={menuItem} checked={showActivity} onCheckedChange={onShowActivity}>
              <Check size={13} className={showActivity ? "text-ink" : "invisible"} />
              Show activity
            </Menu.CheckboxItem>
            {compact ? (
              <>
                <Menu.Item className={menuItem} aria-describedby={descriptionId} disabled={compact.disabled} onClick={compact.run}>
                  <span className="w-3 shrink-0" />
                  {compact.label}
                </Menu.Item>
                <p id={descriptionId} className="team-tools-description">
                  {compact.description}
                </p>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
  // Saved-task activity can render without a thread toolbar; keep its tools reachable.
  return target ? createPortal(menu, target) : <div className="team-tools-inline">{menu}</div>;
}

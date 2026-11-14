import { Menu } from "@base-ui/react/menu";
import { threadFilterLabel, type GroupProject } from "@openorc/client";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { focusedProject, useLayout } from "../lib/layout";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { Check, Funnel, Pin } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { ProjectLogo } from "./ProjectIconPicker";
import { IconButton } from "./ui";

/**
 * The thread list's filter: every thread or the pinned ones, which workspaces the list shows, in its order, and importing
 * terminal sessions. Ticking a workspace keeps the menu open.
 */
export function SidebarThreadFilter({ workspaces }: { workspaces: readonly GroupProject[] }) {
  const pinned = useLayout((s) => s.pinnedOnly);
  const hidden = useLayout((s) => s.hiddenWorkspaces);
  const setPinnedOnly = useLayout((s) => s.setPinnedOnly);
  const projectId = useLayout(focusedProject);
  const filtered = workspaces.filter((workspace) => hidden.includes(workspace.id)).length;
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={threadFilterLabel({ pinnedOnly: pinned, hidden: filtered })} size="xs" className={cn("no-drag", (pinned || filtered > 0) && "text-accent-ink")} />}>
        {/* Pins show their own mark, so the pinned list never looks like the whole one. */}
        {pinned ? <Pin size={16} /> : <Funnel size={16} />}
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {[false, true].map((value) => (
              <Menu.Item key={String(value)} className={menuItem} onClick={() => setPinnedOnly(value)}>
                <Check size={13} className={pinned === value ? "text-accent-ink" : "text-transparent"} />
                {value ? "Pinned threads" : "All threads"}
              </Menu.Item>
            ))}
            {workspaces.length ? (
              <>
                <Menu.Separator className={menuSeparator} />
                <div className="sidebar-filter-workspaces">
                  {workspaces.map((workspace) => (
                    <Menu.CheckboxItem key={workspace.id} className={menuItem} checked={!hidden.includes(workspace.id)} onCheckedChange={() => useLayout.getState().toggleWorkspace(workspace.id)}>
                      <ProjectLogo project={workspace} />
                      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      <Check size={13} className={hidden.includes(workspace.id) ? "text-transparent" : "text-accent-ink"} />
                    </Menu.CheckboxItem>
                  ))}
                </div>
              </>
            ) : null}
            <Menu.Separator className={menuSeparator} />
            <Menu.Item className={menuItem} onClick={() => useUi.getState().setImportSessions(true, projectId ?? undefined)}>
              Import terminal sessions…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

import { Menu } from "@base-ui/react/menu";
import type { FileScope } from "@openorc/protocol";
import { Check, MoreHorizontal, Plus, RefreshCw } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { floatingGround } from "../lib/use-anchor-ground";
import { CoversPreview } from "../lib/browser-preview";
import { IconButton, Tooltip } from "../components/ui";
import { queryClient } from "../lib/query";
import { useUi } from "../lib/ui";

export function FileExplorerToolbar({ scope, showIgnored, onShowIgnored }: { scope: FileScope; showIgnored: boolean; onShowIgnored: (show: boolean) => void }) {
  return (
    <header className="file-explorer-toolbar">
      <span className="text-xs text-ink-3 flex-1">Explorer</span>
      <Tooltip label="Refresh files">
        <IconButton size="xs" aria-label="Refresh files" onClick={() => void queryClient.invalidateQueries({ queryKey: ["files.list"] })}>
          <RefreshCw size={13} />
        </IconButton>
      </Tooltip>
      <Tooltip label="New file">
        <IconButton size="xs" aria-label="New file" onClick={() => useUi.getState().setNewFile(scope)}>
          <Plus size={14} />
        </IconButton>
      </Tooltip>
      <Menu.Root>
        <Menu.Trigger render={<IconButton size="xs" aria-label="Explorer options" title="Explorer options" />}>
          <MoreHorizontal size={14} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              <Menu.CheckboxItem className={menuItem} checked={showIgnored} onCheckedChange={onShowIgnored}>
                <Check size={14} className={showIgnored ? "" : "invisible"} />
                Show ignored files
              </Menu.CheckboxItem>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </header>
  );
}

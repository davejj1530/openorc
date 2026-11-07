import type { FileScope } from "@openorc/protocol";
import { Plus, RefreshCw } from "../components/icons";
import { IconButton, Tooltip } from "../components/ui";
import { queryClient } from "../lib/client";
import { useUi } from "../lib/ui";

export function FileExplorerToolbar({ scope }: { scope: FileScope }) {
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
    </header>
  );
}

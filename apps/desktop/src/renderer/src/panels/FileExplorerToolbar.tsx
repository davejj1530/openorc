import type { FileScope } from "@openorc/protocol";
import { HostedControlReason } from "../components/HostedControlReason";
import { Plus, RefreshCw } from "../components/icons";
import { IconButton, Tooltip } from "../components/ui";
import { queryClient, useRpc } from "../lib/client";
import { useUi } from "../lib/ui";
import { useHostedCapabilities } from "../hooks/useHostedCapabilities";
import { CloudFilesRefresh } from "./CloudFilesRefresh";

/**
 * The explorer's title and its actions. A cloud thread's files are a copy of its newest save, whose age is read once
 * they are `listed`; New file makes one on its machine once its server writes them.
 */
export function FileExplorerToolbar({ scope, listed }: { scope: FileScope; listed: boolean }) {
  const thread = useRpc("threads.get", { id: scope.id }, { enabled: scope.kind === "thread" }).data;
  const cloud = scope.kind === "thread" && thread?.owner?.brain === "hosted";
  const newFileReason = useHostedCapabilities(cloud ? thread : null).reason("fileWrite");
  return (
    <header className="file-explorer-toolbar">
      <span className="text-xs text-ink-3 flex-1">Explorer</span>
      {cloud ? (
        <CloudFilesRefresh threadId={scope.id} listed={listed} />
      ) : (
        <Tooltip label="Refresh files">
          <IconButton size="xs" aria-label="Refresh files" onClick={() => void queryClient.invalidateQueries({ queryKey: ["files.list"] })}>
            <RefreshCw size={13} />
          </IconButton>
        </Tooltip>
      )}
      {newFileReason ? (
        <HostedControlReason label="New file" reason={newFileReason}>
          <IconButton size="xs" aria-label="New file" disabled>
            <Plus size={14} />
          </IconButton>
        </HostedControlReason>
      ) : (
        <Tooltip label="New file">
          <IconButton size="xs" aria-label="New file" onClick={() => useUi.getState().setNewFile(scope)}>
            <Plus size={14} />
          </IconButton>
        </Tooltip>
      )}
    </header>
  );
}

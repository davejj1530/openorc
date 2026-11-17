import { HOSTED_REASONS, type FileScope } from "@openorc/protocol";
import { HostedControlReason } from "../components/HostedControlReason";
import { Plus, RefreshCw } from "../components/icons";
import { IconButton, Tooltip } from "../components/ui";
import { queryClient, useRpc } from "../lib/client";
import { useUi } from "../lib/ui";
import { CloudFilesRefresh } from "./CloudFilesRefresh";

/**
 * The explorer's title and its actions. A cloud thread's files are a copy of its newest save, whose age is read once
 * they are `listed`, and New file waits for writes there.
 */
export function FileExplorerToolbar({ scope, listed }: { scope: FileScope; listed: boolean }) {
  const thread = useRpc("threads.get", { id: scope.id }, { enabled: scope.kind === "thread" }).data;
  const cloud = scope.kind === "thread" && thread?.owner?.brain === "hosted";
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
      {cloud ? (
        <HostedControlReason label="New file" reason={HOSTED_REASONS.fileWrite}>
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

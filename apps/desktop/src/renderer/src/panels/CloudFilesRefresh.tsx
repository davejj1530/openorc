import { useState } from "react";
import { relativeTime } from "@openorc/client";
import { RefreshCw } from "../components/icons";
import { Button, Dialog, IconButton, Tooltip } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { Ends } from "./HostedBring";

/**
 * Refresh for a cloud thread's files, which are a copy of its newest save: its tooltip says how old the copy is, and
 * it has the machine leave with newer work first. Pressed, it shows at once that it works, and that it waits for the
 * turn when one runs; a refusal comes back in words (`onFailed`). When leaving would end something running there, it
 * names what and goes on only once the person says so, as Bring does.
 */
export function CloudFilesRefresh({ threadId, listed, onFailed }: { threadId: string; listed: boolean; onFailed: (message: string | null) => void }) {
  const copy = useRpc("threads.cloudCopy", { threadId }, { enabled: listed }).data;
  const turn = useRpc("threads.get", { id: threadId }).data?.activity === "running";
  const refresh = useRpcMutation("threads.cloudCopyRefresh");
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const go = (endsOk: boolean) => {
    if (refresh.isPending) return;
    onFailed(null);
    refresh.mutate(
      { threadId, endsOk },
      {
        onSuccess: (result) => {
          setConfirm("confirm" in result ? result.confirm : null);
          if ("copy" in result) void queryClient.invalidateQueries({ queryKey: ["files.list"] });
        },
        onError: (error) => onFailed(error.message),
      },
    );
  };
  const saved = copy ? ` · saved ${relativeTime(Date.parse(copy.asOf.at))}` : "";
  const label = refresh.isPending ? (turn ? "Waits for the turn to end" : "Refreshing files…") : `Refresh files${saved}`;
  return (
    <>
      <Tooltip label={label}>
        <IconButton size="xs" aria-label={refresh.isPending ? label : "Refresh files"} aria-busy={refresh.isPending} onClick={() => go(false)}>
          <RefreshCw size={13} className={cn(refresh.isPending && "animate-spin")} />
        </IconButton>
      </Tooltip>
      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? undefined : setConfirm(null))} title="Refresh the thread's files?">
        <Ends lead="The thread leaves its cloud machine to save its work, which ends:" ends={confirm ?? []} />
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="primary" disabled={refresh.isPending} onClick={() => go(true)}>
            Refresh
          </Button>
        </div>
      </Dialog>
    </>
  );
}

import { useState, type ReactNode } from "react";
import type { BringResult } from "@openorc/protocol";
import { HostedControlReason } from "../components/HostedControlReason";
import { Download } from "../components/icons";
import { PanelNotice } from "../components/PanelBar";
import { Button, Dialog } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";

/** Whether a cloud thread's project came from a folder of a Mac, which takes its work back in place of Push. */
export function useBringable(threadId: string) {
  return useRpc("macProjects.bringState", { threadId }, { staleTime: 0 });
}

/** What came, in a few words. */
function broughtLine({ branch, commits, uncommitted }: Extract<BringResult, { brought: unknown }>["brought"]): string {
  const came = commits === 0 ? `${branch} on this Mac already has this work.` : `Brought ${commits === 1 ? "1 commit" : `${commits} commits`} to this Mac as ${branch}.`;
  return uncommitted ? `${came} Changes it didn't commit stayed in the cloud.` : came;
}

/** Names what would end, as "pnpm dev and a terminal". */
export const listed = (ends: readonly string[]) => (ends.length < 2 ? (ends[0] ?? "") : `${ends.slice(0, -1).join(", ")} and ${ends.at(-1)}`);

/**
 * Brings the thread's newest commits into the folder its project came from, as the thread's branch. Held, with why on
 * hover, when the work can't come here now. When making the work current would end something running in the cloud, it
 * names what first and lets the person go on or not; with nothing running it just brings it.
 */
export function useHostedBring(threadId: string): { mac: boolean; control: ReactNode; notice: ReactNode } {
  const state = useBringable(threadId);
  const bring = useRpcMutation("macProjects.bring");
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [line, setLine] = useState<string | null>(null);
  if (!state.data?.mac) return { mac: false, control: null, notice: null };
  const busy = bring.isPending ? "Bringing the thread's work to this Mac." : null;
  const reason = state.data.can ? busy : state.data.reason;
  const go = (endsOk: boolean) =>
    bring.mutate(
      { threadId, endsOk },
      {
        onSuccess: (result) => {
          setConfirm(null);
          if ("confirm" in result) setConfirm(result.confirm);
          else setLine(broughtLine(result.brought));
          void state.refetch();
        },
      },
    );
  const control = (
    <>
      <HostedControlReason label="Bring to this Mac" reason={reason}>
        <Button variant="primary" disabled={Boolean(reason)} onClick={() => go(false)}>
          <Download size={14} />
          {bring.isPending ? "Bringing…" : "Bring to this Mac"}
        </Button>
      </HostedControlReason>
      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? undefined : setConfirm(null))} title="Bring the thread's work to this Mac?">
        <p className="text-base text-ink-2 break-words">The thread leaves its cloud machine to save its work, which ends {listed(confirm ?? [])}.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="primary" disabled={bring.isPending} onClick={() => go(true)}>
            Bring
          </Button>
        </div>
      </Dialog>
    </>
  );
  const notice =
    line || bring.error ? (
      <PanelNotice role={bring.error ? "alert" : "status"} tone={bring.error ? "bad" : "muted"}>
        {bring.error?.message ?? line}
      </PanelNotice>
    ) : null;
  return { mac: true, control, notice };
}

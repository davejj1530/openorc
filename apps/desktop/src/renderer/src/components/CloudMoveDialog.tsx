import { hostedStart } from "@openorc/client";
import type { AccountStatus, ThreadSummary } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { useOrganization } from "../lib/organization-context";
import { thisComputer } from "../lib/this-computer";
import { useUi } from "../lib/ui";
import { Ends } from "../panels/HostedBring";
import { Button, Dialog } from "./ui";

/** Where a thread's move would take it, and why it can't go now; `space` names a team's space it would land in. */
export interface CloudMoveOffer {
  to: "cloud" | "mac";
  held: string | null;
  space: string | null;
  ends: string[];
}

/** The core found the thread's cloud project, in whichever space: the gate's project step passes. */
function reached(account: AccountStatus | undefined, projectId: string): AccountStatus | undefined {
  return account?.state === "signed-in" ? { ...account, projects: [{ projectId, repo: "", cloud: "added" }] } : account;
}

/**
 * Whether the thread moves between this computer and OpenOrc Cloud, and why not now. A move to the cloud passes the
 * gate a cloud start passes, in its words, then the core's own (a turn under way, a move under way). Null while the
 * core is asked, while the thread is read, for a thread that never moves, and for a person with no account.
 */
export function useCloudMove(thread: Pick<ThreadSummary, "id" | "projectId" | "agent" | "model"> | undefined, threadId = thread?.id ?? ""): CloudMoveOffer | null {
  const check = useRpc("threads.moveCheck", { threadId }, { staleTime: 0 }).data;
  const account = useRpc("account.status", {}).data;
  const spaces = useOrganization()?.status;
  if (!thread || !check || check.to === "none") return null;
  if (check.to === "mac") return { to: "mac", held: check.can ? null : check.reason, space: null, ends: check.can ? check.ends : [] };
  const gate = hostedStart(check.can ? reached(account, thread.projectId) : account, { projectId: thread.projectId, agent: thread.agent, model: thread.model });
  if (!gate.shown) return null;
  const landing = check.can && !check.space.personal && spaces?.state === "ready" ? spaces.spaces.find((space) => space.id === check.space.id) : undefined;
  const team = landing?.kind === "organization" ? landing.name : null;
  return { to: "cloud", held: gate.blocked?.words ?? (check.can ? null : check.reason), space: team, ends: [] };
}

/**
 * Starts a thread's move. A move can be undone by moving back, so it asks first only when there is something to know:
 * a team's space it lands in, or what leaving its cloud machine ends (also when that turns up only as it starts). A
 * start that fails opens the confirm with why.
 */
export function useStartCloudMove(): (threadId: string, offer: CloudMoveOffer | null) => void {
  const move = useRpcMutation("threads.move");
  return (threadId, offer) => {
    const ui = useUi.getState();
    if (offer?.space || offer?.ends.length) return ui.setCloudMove(threadId);
    move.mutateAsync({ threadId, endsOk: false }).then(
      (started) => ("confirm" in started ? ui.setCloudMove(threadId) : undefined),
      (error: unknown) => ui.setCloudMove(threadId, error instanceof Error ? error.message : String(error)),
    );
  };
}

/** The confirm for a thread moving between this computer and OpenOrc Cloud: the team's space it lands in, and what leaving its cloud machine ends. */
export function CloudMoveDialog() {
  const asked = useUi((state) => state.cloudMove);
  return asked ? <MoveDialog key={asked.threadId} threadId={asked.threadId} failed={asked.error} /> : null;
}

function MoveDialog({ threadId, failed }: { threadId: string; failed: string | null }) {
  const thread = useRpc("threads.get", { id: threadId }).data;
  const offer = useCloudMove(thread ?? undefined, threadId);
  const move = useRpcMutation("threads.move");
  const close = () => {
    if (!move.isPending) useUi.getState().setCloudMove(null);
  };
  // The dialog names what would end, so the move goes on past it.
  const submit = () => move.mutate({ threadId, endsOk: true }, { onSuccess: () => useUi.getState().setCloudMove(null) });
  const to = offer?.to ?? (thread?.owner?.brain === "hosted" ? "mac" : "cloud");
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())} title={to === "cloud" ? "Move to OpenOrc Cloud?" : `Move to ${thisComputer}?`} width={480}>
      <div>
        {offer?.space ? <p className="mb-3 text-base text-ink-2 break-words">Everyone in {offer.space} can read it there.</p> : null}
        {offer?.ends.length ? (
          <div className="mb-3">
            <Ends lead="Leaving its cloud machine ends:" ends={offer.ends} />
          </div>
        ) : null}
        {offer?.held || move.error || failed ? (
          <p role="alert" className="mb-3 text-sm text-bad break-words">
            {move.error?.message ?? offer?.held ?? failed}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={move.isPending} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={move.isPending || !offer || Boolean(offer.held)} onClick={submit}>
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

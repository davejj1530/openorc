import { useEffect } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { fileCount } from "@openorc/client";
import { HostedReviewState } from "../components/HostedReviewState";
import { DiffStat, PanelBar, PanelBarMeta } from "../components/PanelBar";
import { RefreshCw } from "../components/icons";
import { Button, IconButton, Tooltip } from "../components/ui";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import type { ChangeSelection } from "../lib/layout";
import { HostedPublish } from "./HostedPublish";
import { HostedReviewFiles } from "./HostedReviewFiles";
import { useHostedChangesReason } from "../hooks/useHostedCapabilities";

export function HostedChangesPanel({ thread }: { thread: ThreadSummary }) {
  const off = useHostedChangesReason(thread.id);
  const read = useRpc("hosted.review.changes", { threadId: thread.id }, { enabled: off === null });
  const state = useRpc("hosted.review.state", { threadId: thread.id });
  const refresh = () => {
    if (off === null) void read.refetch();
    void state.refetch();
  };
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  });
  const changes = read.data;
  const recorded = !read.error && changes?.state === "recorded" ? changes : null;
  return (
    <div className="h-full flex flex-col min-h-0">
      <HostedPublish
        key={thread.id}
        thread={thread}
        state={state.error ? undefined : state.data}
        stateError={state.error}
        changes={read.error ? undefined : changes}
        heading={<span data-tip={recorded ? `Since ${thread.baseBranch ?? "the starting commit"} (${recorded.baseSha.slice(0, 7)})` : undefined}>Branch</span>}
        meta={
          recorded ? (
            <>
              <PanelBarMeta>{fileCount(recorded.totals.files)}</PanelBarMeta>
              <DiffStat add={recorded.totals.insertions} del={recorded.totals.deletions} />
            </>
          ) : null
        }
        refresh={
          <Tooltip label="Refresh">
            <IconButton onClick={refresh} aria-label="Refresh" className="text-ink-4">
              <RefreshCw size={15} className={cn(read.isFetching && "animate-spin")} />
            </IconButton>
          </Tooltip>
        }
      />
      <HostedReviewState changes={changes} error={read.error} retry={refresh} unavailable={Boolean(off)} />
      {!read.error && recorded && recorded.totals.files > 0 ? <HostedReviewFiles key={recorded.treeSha} threadId={thread.id} changes={recorded} /> : null}
    </div>
  );
}

export function HostedSavedChangesPanel({ selection, onAll }: { selection: ChangeSelection; onAll: () => void }) {
  const off = useHostedChangesReason(selection.id);
  const read = useRpc("hosted.review.turn", { threadId: selection.id, turnId: selection.checkpointId }, { enabled: off === null });
  const changes = read.data;
  return (
    <section className="h-full flex flex-col min-h-0" aria-label="Selected code changes">
      <PanelBar title="Saved changes" meta={!read.error && changes?.state === "recorded" ? <PanelBarMeta>{fileCount(changes.totals.files)}</PanelBarMeta> : null}>
        <Button variant="ghost" onClick={onAll}>
          All changes
        </Button>
      </PanelBar>
      <HostedReviewState changes={changes} error={read.error} retry={() => void read.refetch()} unavailable={Boolean(off)} />
      {!read.error && changes?.state === "recorded" && changes.totals.files > 0 ? (
        <HostedReviewFiles threadId={selection.id} changes={changes} turnId={selection.checkpointId} paths={selection.paths} />
      ) : null}
    </section>
  );
}

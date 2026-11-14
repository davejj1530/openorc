import { lazy, Suspense, useState } from "react";
import type { HostedThreadChanges, HostedTurnChanges } from "@openorc/protocol";
import { hostedFilePatch } from "@openorc/client";
import { useRpc } from "../lib/client";
import { PanelNotice } from "../components/PanelBar";
import { Button, Empty } from "../components/ui";
import { FileRows } from "./FileRows";

const DiffView = lazy(() => import("../components/DiffView").then((module) => ({ default: module.DiffView })));

export function HostedReviewFiles({
  threadId,
  changes,
  turnId,
  paths,
}: {
  threadId: string;
  changes: Extract<HostedThreadChanges | HostedTurnChanges, { state: "recorded" }>;
  turnId?: string;
  paths?: string[];
}) {
  const files = paths?.length ? changes.files.filter((file) => paths.includes(file.path)) : changes.files;
  const [selected, setSelected] = useState<string | null>(null);
  const path = files.find((file) => file.path === selected)?.path ?? files[0]?.path;
  return (
    <>
      {"missing" in changes && changes.missing ? <PanelNotice role="status">{changes.missing}</PanelNotice> : null}
      {files.length > 1 || files[0]?.body.kind !== "text" ? <FileRows files={files} onSelect={setSelected} selected={path} /> : null}
      {changes.unlisted ? <PanelNotice>{changes.unlisted} more files are not listed.</PanelNotice> : null}
      {path ? <HostedFile key={path} threadId={threadId} path={path} turnId={turnId} /> : null}
    </>
  );
}

function HostedFile({ threadId, path, turnId }: { threadId: string; path: string; turnId?: string }) {
  const read = useRpc("hosted.review.file", { threadId, path, ...(turnId && { turnId }) });
  const file = read.data;
  if (read.error)
    return (
      <Empty title="Could not read this diff">
        <p role="alert">{read.error.message}</p>
        <Button className="mt-3" onClick={() => void read.refetch()}>
          Retry
        </Button>
      </Empty>
    );
  if (!file)
    return (
      <p role="status" className="px-5 py-2.5 text-sm text-ink-3">
        Loading diff…
      </p>
    );
  return (
    <>
      {file.note ? <PanelNotice role="status">{file.note}</PanelNotice> : null}
      {file.cut ? (
        <PanelNotice role="status">
          Showing {file.cut.shownLines.toLocaleString()} of {file.cut.totalLines.toLocaleString()} lines.
        </PanelNotice>
      ) : null}
      <div className="flex-1 min-h-0">
        <Suspense fallback={null}>
          <DiffView patch={hostedFilePatch(file)} />
        </Suspense>
      </div>
    </>
  );
}

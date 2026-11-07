import { lazy, Suspense, type ReactNode } from "react";
import { PanelBar, PanelBarMeta } from "../components/PanelBar";
import { Button } from "../components/ui";
import { useRpc } from "../lib/client";
import { useLayout, type ChangeSelection } from "../lib/layout";

const DiffView = lazy(() => import("../components/DiffView").then((module) => ({ default: module.DiffView })));

/** A card opens only its immutable saved diff; later workspace edits never leak into this review. */
export function SavedChangesPanel({ selection }: { selection: ChangeSelection }) {
  const clear = useLayout((state) => state.clearChanges);
  const diff = useRpc("threads.turnChanges", { ...withoutKind(selection), includePatch: true }, { staleTime: Infinity });
  let diffContent: ReactNode;
  if (diff.isError) {
    diffContent = (
      <div role="alert" className="px-5 py-2.5 text-sm">
        Could not load this saved diff.{" "}
        <Button size="sm" variant="ghost" onClick={() => void diff.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (!diff.data) {
    diffContent = (
      <p role="status" className="px-5 py-2.5 text-sm text-ink-3">
        Loading saved changes…
      </p>
    );
  } else {
    diffContent = (
      <div className="flex-1 min-h-0">
        <Suspense fallback={<p className="p-3">Loading review…</p>}>
          <DiffView patch={diff.data.patch ?? ""} />
        </Suspense>
      </div>
    );
  }
  return (
    <section className="h-full flex flex-col min-h-0" aria-label="Selected code changes">
      <PanelBar title="Saved changes" meta={diff.data ? <PanelBarMeta>{`${diff.data.files.length} ${diff.data.files.length === 1 ? "file" : "files"}`}</PanelBarMeta> : null}>
        <Button variant="ghost" onClick={clear}>
          All changes
        </Button>
      </PanelBar>
      <p className="panel-notice">Only files selected from this turn’s card, as they were saved when the turn ended.</p>
      {diffContent}
    </section>
  );
}

function withoutKind<T extends { kind: string }>(selection: T): Omit<T, "kind"> {
  const { kind: _kind, ...rest } = selection;
  return rest;
}

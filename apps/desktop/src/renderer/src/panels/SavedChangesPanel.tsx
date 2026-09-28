import { lazy, Suspense, type ReactNode } from "react";
import { Button } from "../components/ui";
import { useRpc } from "../lib/query";
import { useLayout, type ChangeSelection } from "../lib/layout";

const DiffView = lazy(() => import("../components/DiffView").then((module) => ({ default: module.DiffView })));

/** A card opens only its immutable saved diff; later workspace edits never leak into this review. */
export function SavedChangesPanel({ selection }: { selection: ChangeSelection }) {
  const clear = useLayout((state) => state.clearChanges);
  const team = selection.kind === "team";
  const teamDiff = useRpc("orchestration.turnChanges", team ? { ...withoutKind(selection), includePatch: true } : { threadId: "", executionId: "", turnId: "", includePatch: true }, {
    enabled: team,
    staleTime: Infinity,
  });
  const threadDiff = useRpc("threads.turnChanges", !team ? { ...withoutKind(selection), includePatch: true } : { id: "", checkpointId: "", includePatch: true }, {
    enabled: !team,
    staleTime: Infinity,
  });
  const diff = team ? teamDiff : threadDiff;
  let diffContent: ReactNode;
  if (diff.isError) {
    diffContent = (
      <div role="alert" className="p-3 text-sm">
        Could not load this saved diff.{" "}
        <Button size="sm" variant="ghost" onClick={() => void diff.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (!diff.data) {
    diffContent = (
      <p role="status" className="p-3 text-sm text-ink-3">
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
      <header className="flex items-center gap-3 px-3 py-2 border-b border-line shrink-0">
        <strong className="text-base font-medium">Saved changes{diff.data ? ` · ${diff.data.files.length} ${diff.data.files.length === 1 ? "file" : "files"}` : ""}</strong>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={clear}>
          All changes
        </Button>
      </header>
      <p className="px-3 py-2 text-sm text-ink-3 border-b border-line">
        {team
          ? "Only files selected from this turn’s card. Shared checkpoint; concurrent edits may be included."
          : "Only files selected from this turn’s card, as they were saved when the turn ended."}
      </p>
      {diffContent}
    </section>
  );
}

function withoutKind<T extends { kind: string }>(selection: T): Omit<T, "kind"> {
  const { kind: _kind, ...rest } = selection;
  return rest;
}

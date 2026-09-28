import { ChangeCard } from "./ChangeCard";
import { useRpc } from "../lib/query";
import type { RpcParams } from "@openorc/protocol";
import { useLayout } from "../lib/layout";

/** An immutable shared-workspace comparison, attached to the turn that captured it. */
export function TeamChangeCard({ scope, paths }: { scope: Omit<RpcParams<"orchestration.turnChanges">, "includePatch">; paths: string[] }) {
  const openReview = useLayout((state) => state.openChanges);
  const summary = useRpc("orchestration.turnChanges", scope, { staleTime: Infinity });
  const files = summary.data?.files ?? paths.map((path) => ({ path, added: null, removed: null }));
  return (
    <ChangeCard
      files={files}
      counted={Boolean(summary.data)}
      note="Shared workspace checkpoint · may include concurrent edits"
      error={summary.isError ? "Change counts unavailable." : null}
      onRetry={() => void summary.refetch()}
      onReview={(selected) => openReview({ kind: "team", ...scope, paths: selected })}
    />
  );
}

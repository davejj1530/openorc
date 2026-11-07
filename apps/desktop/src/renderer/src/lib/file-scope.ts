import { isSubagentThread, type FileScope, type ThreadSummary } from "@openorc/protocol";
import { queryClient } from "./client";
import { core } from "./rpc";

/** Hosted conversations have no workspace panel. Check before changing panel or focus state. */
export function withFileScope(scope: FileScope, open: () => void): void {
  if (scope.kind !== "thread") return open();
  const known = queryClient.getQueryData<ThreadSummary | null>(["threads.get", { id: scope.id }]);
  if (known !== undefined) {
    if (known && !isSubagentThread(known)) open();
    return;
  }
  void core
    .call("threads.get", { id: scope.id })
    .then((thread) => {
      if (thread && !isSubagentThread(thread)) open();
    })
    .catch(() => {});
}

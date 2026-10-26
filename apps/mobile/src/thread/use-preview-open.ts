import type { ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../client";

/**
 * Whether the More menu lists Preview: the Mac shows a page for this thread. Main's `preview:<id>` invalidation reads
 * it again when the page opens or closes; a Mac that does not know the method answers with an error, so no Preview.
 */
export function usePreviewOpen(thread: ThreadSummary | null): boolean {
  const state = useRpc("preview.state", { threadId: thread?.id ?? "" }, { enabled: thread !== null });
  return state.data?.open === true;
}

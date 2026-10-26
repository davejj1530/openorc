import { pageLabel } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useMemo } from "react";
import { useRpc } from "../client";
import type { ThreadPanels } from "./thread-actions";

/**
 * Preview as the More menu lists it: always, with the page the Mac shows for this thread beneath it. Main's
 * `preview:<id>` invalidation reads it again when the page opens, closes or changes; a Mac that does not know the
 * method answers with an error, so it lists no Preview.
 */
export function usePreviewPanel(thread: ThreadSummary | null): ThreadPanels["preview"] {
  const state = useRpc("preview.state", { threadId: thread?.id ?? "" }, { enabled: thread !== null });
  const listed = thread !== null && !state.error;
  const page = state.data?.open ? pageLabel({ url: state.data.address, title: state.data.title }) : null;
  return useMemo(() => (listed ? { page } : null), [listed, page]);
}

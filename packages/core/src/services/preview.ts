import { teamDeletedThreads, threads, type Db } from "@openorc/db";
import type { PreviewFrame, PreviewHost, PreviewHostPage, PreviewPhase, PreviewState } from "@openorc/protocol";

/** What a phone hears when the thread it watches, or asks to watch, is no more. */
export const PREVIEW_THREAD_GONE = "This thread is gone.";

/** Whether a thread can have a Preview: it exists, and no team deletion hid it. */
export const previewThreadLive = (db: Db, threadId: string): boolean => Boolean(threads.get(db, threadId)) && !teamDeletedThreads.has(db, threadId);

/** The phase a phone draws: a crash first, since a crashed pane also carries its error, then a failed load, then a load. */
function phase(page: PreviewHostPage): PreviewPhase {
  if (page.crashed) return "stopped";
  if (page.error !== null) return "failed";
  return page.loading ? "loading" : "live";
}

/** Main's reading of a thread's page as a state, with the frame a watcher holds, or none. Unshaped: the Mac's own words. */
export function previewState(page: PreviewHostPage | null, frame: PreviewFrame | null): PreviewState {
  if (!page) return { open: false };
  return { open: true, pane: page.pane, address: page.url, title: page.title, phase: phase(page), error: page.error, frame };
}

/** Whether a page is open, or which tab is shown, decides More's Preview item; repaints and loads do not. */
export function invalidateOnLifecycle(preview: PreviewHost | undefined, invalidate: (keys: string[]) => void): void {
  preview?.onChange((threadId, lifecycle) => {
    if (lifecycle) invalidate([`preview:${threadId}`]);
  });
}

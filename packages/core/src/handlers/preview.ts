import type { Db } from "@openorc/db";
import type { PreviewHost } from "@openorc/protocol";
import { previewState, previewThreadLive } from "../services/preview.js";
import type { Handlers } from "./types.js";

type Dependencies = { db: Db; preview: PreviewHost | undefined };

/** A missing or team-deleted thread has no Preview, and main is not asked about it. Without a host (tests, probes), none does. */
export function createPreviewHandlers({ db, preview }: Dependencies): Pick<Handlers, "preview.state"> {
  return {
    "preview.state": async ({ threadId }) => {
      if (!preview || !previewThreadLive(db, threadId)) return { open: false };
      return previewState(await preview.query(threadId), null);
    },
  };
}

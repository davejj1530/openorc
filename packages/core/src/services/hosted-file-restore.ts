import { randomUUID } from "node:crypto";
import type { Hosted } from "@openorc/hosted";
import { hostedFileReference, type HostedFileDraft } from "@openorc/protocol";
import type { HostedFileStore } from "./hosted-file-store.js";

/** Withdrawn messages reuse their completed uploads. Only metadata is kept locally, with no new reservation. */
export async function restoreHostedFiles(store: HostedFileStore, files: Hosted["files"], draft: HostedFileDraft & { paths: string[] }): Promise<void> {
  const kept = await store.list(draft);
  for (const path of draft.paths) {
    const ref = hostedFileReference(path);
    if (!ref) throw new Error("This file isn't available in this space.");
    if (kept.some((record) => record.phase === "ready" && record.file?.id === ref.id)) continue;
    const file = await files.complete(draft.scope, ref.id);
    await files.capture(draft.scope);
    const record = await store.begin({ scope: draft.scope, draftKey: draft.draftKey, id: randomUUID(), name: file.name, bytes: file.bytes, mime: file.contentType });
    const ready = await store.update(record, (row) => ({ ...row, phase: "ready", file, failure: null }));
    kept.push(ready);
  }
}

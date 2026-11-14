import type { HostedFileDiff, HostedThreadChanges, HostedTurnChanges, TurnFileChanges, WorkspaceChanges } from "@openorc/protocol";
import { Refused } from "./session.js";

/** The older result has no place for a missing checkpoint or an incomplete list. */
export function reviewChanges(changes: HostedThreadChanges): WorkspaceChanges {
  if (changes.state !== "recorded") throw new Refused(changes.line);
  if (changes.missing) throw new Refused(changes.missing);
  return changes;
}

export function turnFiles(changes: HostedTurnChanges): TurnFileChanges["files"] {
  if (changes.state !== "recorded") throw new Refused(changes.line);
  if (changes.unlisted) throw new Refused("Open Changes to read this turn's full file count.");
  return changes.files.map((file) => ({ path: file.path, added: file.body.kind === "text" ? file.body.insertions : null, removed: file.body.kind === "text" ? file.body.deletions : null }));
}

/** Older patch readers cannot draw withheld or cut hunks honestly. */
export function completePatch(files: HostedFileDiff[]): string {
  return files
    .map((file) => {
      if (file.note || file.cut || file.body.kind !== "text") throw new Refused(file.note ?? "Open Changes to read this file's saved diff.");
      const before = file.oldPath ?? file.path;
      return `diff --git a/${before} b/${file.path}\n--- ${file.status === "added" ? "/dev/null" : `a/${before}`}\n+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}\n${file.patch}`;
    })
    .join("\n");
}

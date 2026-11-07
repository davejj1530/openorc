import { decodeNewThreadDraft, type NewThreadDraft } from "@openorc/client";
import { readDraft, writeDraft } from "./drafts";

const key = (projectId: string) => `newthread.${projectId}.execution`;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function readNewThreadDraft(projectId: string): NewThreadDraft {
  let legacyPrompt = "";
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem("openorc.draft.new") ?? "{}");
    if (object(legacy) && typeof legacy[projectId] === "string") legacyPrompt = legacy[projectId];
  } catch {
    /* A malformed legacy draft must not prevent choosing a target. */
  }
  return decodeNewThreadDraft(projectId, readDraft<unknown>(key(projectId), null), legacyPrompt);
}

export function writeNewThreadDraft(draft: NewThreadDraft): boolean {
  return writeDraft(key(draft.projectId), draft);
}

export function rememberNewThreadProject(projectId: string): void {
  try {
    localStorage.setItem("openorc.newthread.project", projectId);
  } catch {
    /* The in-memory selection stays usable. */
  }
}

export function readNewThreadProject(): string | null {
  try {
    return localStorage.getItem("openorc.newthread.project");
  } catch {
    return null;
  }
}

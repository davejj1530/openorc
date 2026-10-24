import { decodeNewThreadDraft, type NewThreadDraft } from "@openorc/client";
import type { TeamRevision } from "@openorc/protocol";
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

export function teamLaunchRequest(previous: NewThreadDraft["launchRequest"], fingerprint: string): NonNullable<NewThreadDraft["launchRequest"]> {
  return previous?.fingerprint === fingerprint ? previous : { key: crypto.randomUUID(), fingerprint };
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

export function teamDepth(revision: TeamRevision): number {
  const members = new Map(revision.members.map((member) => [member.key, member]));
  return Math.max(
    ...revision.members.map((member) => {
      const seen = new Set<string>();
      let current = member,
        depth = 1;
      while (current.managerKey) {
        if (seen.has(current.key)) return Infinity;
        seen.add(current.key);
        const manager = members.get(current.managerKey);
        if (!manager) return Infinity;
        depth += 1;
        current = manager;
      }
      return depth;
    }),
  );
}

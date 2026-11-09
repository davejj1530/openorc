import { PermissionPreset, type ThreadSummary } from "@openorc/protocol";
import { useCallback, useState } from "react";
import { shownMacId, storage, useHostClient } from "../client";
import { decodeSheetDraft, type SheetDraft } from "./new-thread-state";

const draftKey = (projectId: string) => `newthread.${shownMacId() ?? "none"}.${projectId}`;
const projectKey = () => `newthread.${shownMacId() ?? "none"}.project`;
const permissionKey = () => `newthread.${shownMacId() ?? "none"}.permission`;
const subthreadKey = (parentId: string) => `newsubthread.${shownMacId() ?? "none"}.${parentId}`;

function read(projectId: string): SheetDraft {
  try {
    return decodeSheetDraft(projectId, JSON.parse(storage.getString(draftKey(projectId)) ?? "null"));
  } catch {
    return decodeSheetDraft(projectId, null);
  }
}

/**
 * A project's new thread, kept on the phone per Mac and project as the person writes and chooses, so closing the sheet,
 * switching projects or a start the Mac refuses keeps it. Switching projects switches the draft in place.
 */
export function useSheetDraft(projectId: string): [SheetDraft, (update: (draft: SheetDraft) => SheetDraft) => void] {
  const [shown, setShown] = useState(() => ({ projectId, draft: read(projectId) }));
  // Another project: its own saved draft, read as the project changes.
  if (shown.projectId !== projectId) setShown({ projectId, draft: read(projectId) });
  const update = useCallback(
    (change: (draft: SheetDraft) => SheetDraft) => {
      // The saved draft is the one to change: a start or an image can land after the sheet has closed.
      const next = change(read(projectId));
      storage.set(draftKey(projectId), JSON.stringify(next));
      setShown({ projectId, draft: next });
    },
    [projectId],
  );
  return [shown.projectId === projectId ? shown.draft : read(projectId), update];
}

/**
 * The permission new threads start with. A phone may not change the Mac's default, so the one chosen in the sheet is
 * kept here per Mac and holds in every project, as the desktop's default does. Until one is chosen, the Mac's applies.
 */
export function useSheetPermission() {
  const [chosen, setChosen] = useState(() => PermissionPreset.safeParse(storage.getString(permissionKey())).data);
  const selection = useHostClient().usePermissionSelection(chosen);
  return {
    ...selection,
    select: (permission: PermissionPreset) => {
      storage.set(permissionKey(), permission);
      setChosen(permission);
    },
  };
}

/** The project last shown in the sheet, so the Home pill opens there again. */
export function rememberedProject(): string | null {
  return storage.getString(projectKey()) ?? null;
}

export function rememberProject(projectId: string): void {
  storage.set(projectKey(), projectId);
}

type Parent = Pick<ThreadSummary, "id" | "projectId" | "agent" | "model" | "effort" | "fastMode" | "mode" | "claudeAccountId">;

/** A subthread's draft before anything is chosen: its parent's model, mode and account, as the desktop starts one. */
function parentDraft(parent: Parent): SheetDraft {
  const choice = parent.model ? { agent: parent.agent, model: parent.model, effort: parent.effort, fastMode: parent.fastMode } : null;
  return { ...decodeSheetDraft(parent.projectId, null), target: { kind: "model", choice }, mode: parent.mode, ...(parent.claudeAccountId ? { claudeAccountId: parent.claudeAccountId } : {}) };
}

function readSubthread(parent: Parent): SheetDraft {
  try {
    const saved: unknown = JSON.parse(storage.getString(subthreadKey(parent.id)) ?? "null");
    return saved === null ? parentDraft(parent) : decodeSheetDraft(parent.projectId, saved);
  } catch {
    return parentDraft(parent);
  }
}

/** A thread's next subthread, kept on the phone per Mac and parent as the person writes and chooses, as a new thread's is. */
export function useSubthreadDraft(parent: Parent): [SheetDraft, (update: (draft: SheetDraft) => SheetDraft) => void] {
  const [draft, setDraft] = useState(() => readSubthread(parent));
  const update = useCallback(
    (change: (draft: SheetDraft) => SheetDraft) => {
      // The saved draft is the one to change: a start or an image can land after the screen has closed.
      const next = change(readSubthread(parent));
      storage.set(subthreadKey(parent.id), JSON.stringify(next));
      setDraft(next);
    },
    [parent],
  );
  return [draft, update];
}

import { PermissionPreset } from "@openorc/protocol";
import { useCallback, useState } from "react";
import { client, shownMacId, storage } from "../client";
import { decodeSheetDraft, type SheetDraft } from "./new-thread-state";

const draftKey = (projectId: string) => `newthread.${shownMacId() ?? "none"}.${projectId}`;
const projectKey = () => `newthread.${shownMacId() ?? "none"}.project`;
const permissionKey = () => `newthread.${shownMacId() ?? "none"}.permission`;

function read(projectId: string): SheetDraft {
  try {
    return decodeSheetDraft(projectId, JSON.parse(storage.getString(draftKey(projectId)) ?? "null"));
  } catch {
    return decodeSheetDraft(projectId, null);
  }
}

/**
 * A project's new thread, kept on the phone per Mac and project as the person writes and chooses, so closing the sheet,
 * switching projects or a start the Mac refuses keeps it.
 */
export function useSheetDraft(projectId: string): [SheetDraft, (update: (draft: SheetDraft) => SheetDraft) => void] {
  const [draft, setDraft] = useState(() => read(projectId));
  const update = useCallback(
    (change: (draft: SheetDraft) => SheetDraft) => {
      // The saved draft is the one to change: a start or an image can land after the sheet has closed.
      const next = change(read(projectId));
      storage.set(draftKey(projectId), JSON.stringify(next));
      setDraft(next);
    },
    [projectId],
  );
  return [draft, update];
}

/**
 * The permission new threads start with. A phone may not change the Mac's default, so the one chosen in the sheet is
 * kept here per Mac and holds in every project, as the desktop's default does. Until one is chosen, the Mac's applies.
 */
export function useSheetPermission() {
  const [chosen, setChosen] = useState(() => PermissionPreset.safeParse(storage.getString(permissionKey())).data);
  const selection = client.usePermissionSelection(chosen);
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

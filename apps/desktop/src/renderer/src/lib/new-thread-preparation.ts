import { useLayoutEffect } from "react";
import { WORKSPACE_ID } from "@openorc/protocol";
import { useComposerAttachments } from "./composer-attachments";
import { focusedProject, useLayout } from "./layout";
import { readNewThreadDraft, readNewThreadProject } from "./new-thread-draft";
import { readDraft } from "./drafts";

let mounted: { prepared: boolean } | null = null;

/** Live preparation includes imports and words that could not be saved locally. */
export function useNewThreadPreparation(projectId: string, prompt: string): void {
  const files = useComposerAttachments({ draftKey: `newthread.${projectId}.attachments` });
  const prepared = Boolean(projectId && projectId !== WORKSPACE_ID) || prompt.length > 0 || files.attachments.length > 0 || files.uploading > 0;
  useLayoutEffect(() => {
    const current = { prepared };
    mounted = current;
    return () => {
      if (mounted === current) mounted = null;
    };
  }, [prepared]);
}

/** A hidden New thread tab can also have saved preparation from an earlier visit. */
export function pristineNewThread(projectId?: string): boolean {
  if (projectId) return false;
  if (mounted) return !mounted.prepared;
  const selected = focusedProject(useLayout.getState()) ?? readNewThreadProject() ?? WORKSPACE_ID;
  if (selected && selected !== WORKSPACE_ID) return false;
  const files = readDraft(`newthread.${selected}.attachments`, { attachments: [] });
  return readNewThreadDraft(selected).prompt.length === 0 && files.attachments.length === 0;
}

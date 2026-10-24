import { conversationSendDisabledReason, decodeNewThreadDraft, targetModel, type NewThreadDraft } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import type { DraftImage } from "../composer/drafts";
import type { ProjectChoice } from "../projects";

/** A project's new thread as the phone keeps it: the desktop's draft (prompt, model, mode) and the images already on the Mac. */
export type SheetDraft = NewThreadDraft & { images: DraftImage[] };

const isImage = (value: unknown): value is DraftImage =>
  Boolean(value && typeof value === "object" && typeof (value as DraftImage).path === "string" && typeof (value as DraftImage).preview === "string");

/** Reads a saved draft with the desktop's own rules; images the phone cannot show are dropped. */
export function decodeSheetDraft(projectId: string, value: unknown): SheetDraft {
  const images = value && typeof value === "object" && Array.isArray((value as { images?: unknown }).images) ? (value as { images: unknown[] }).images.filter(isImage) : [];
  return { ...decodeNewThreadDraft(projectId, value), images };
}

/**
 * The project the sheet opens on: the one it was opened for, else the last one chosen while the Mac still lists it,
 * else Workspace. Until the Mac's projects load, a remembered project is trusted.
 */
export function openingProject(opened: string | undefined, remembered: string | null, choices: readonly ProjectChoice[] | undefined): string {
  if (opened) return opened;
  if (remembered && (!choices || choices.some((choice) => choice.id === remembered))) return remembered;
  return WORKSPACE_ID;
}

/** Why Start cannot go yet, or null: the saved permission still loading, a saved choice that cannot be restored, no model. */
export function startBlocker(draft: Pick<SheetDraft, "target">, { permissionReady }: { permissionReady: boolean }): string | null {
  if (permissionReady && draft.target.kind === "unavailable") return draft.target.reason;
  return conversationSendDisabledReason({ permissionReady, historyLoading: false, historyFailed: false, hasModel: Boolean(targetModel(draft.target)) });
}

/** A started thread took this prompt and these images; anything written or attached since stays for the next one. */
export function afterStart(draft: SheetDraft, sent: { prompt: string; attachments: readonly string[] }): SheetDraft {
  return { ...draft, prompt: draft.prompt.trim() === sent.prompt ? "" : draft.prompt, images: draft.images.filter((image) => !sent.attachments.includes(image.path)) };
}

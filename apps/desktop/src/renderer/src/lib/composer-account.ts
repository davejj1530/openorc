import { useEffect } from "react";
import { create } from "zustand";
import { targetModel } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { focusedProject, useLayout } from "./layout";
import { readNewThreadDraft, readNewThreadProject } from "./new-thread-draft";

/** The agent a new thread would start on, and for Claude the account it would use. */
export type ComposerAccount = { agent: string; claudeAccountId?: string };

/**
 * What the new-thread composer has chosen, as it last showed it. Off a thread the sidebar's usage chip reads it, so
 * the chip follows the composer's picker; it stays after the composer closes, since that is still the setup a new
 * thread would start with.
 */
export const useComposerAccount = create<{ chosen: ComposerAccount | null }>(() => ({ chosen: null }));

export function publishComposerAccount(chosen: ComposerAccount | null): void {
  const current = useComposerAccount.getState().chosen;
  if (current?.agent === chosen?.agent && current?.claudeAccountId === chosen?.claudeAccountId) return;
  useComposerAccount.setState({ chosen });
}

/** The new-thread composer's side: what it would start a thread on, published while it shows. */
export function usePublishComposerAccount(agent: string | undefined, claudeAccountId: string): void {
  useEffect(() => publishComposerAccount(agent ? { agent, claudeAccountId } : null), [agent, claudeAccountId]);
}

/** Before the composer has opened, the setup its saved draft holds for the project the sidebar is on. */
export function savedComposerAccount(): ComposerAccount | null {
  const draft = readNewThreadDraft(focusedProject(useLayout.getState()) ?? readNewThreadProject() ?? WORKSPACE_ID);
  const choice = targetModel(draft.target);
  return choice ? { agent: choice.agent, ...(draft.claudeAccountId ? { claudeAccountId: draft.claudeAccountId } : {}) } : null;
}

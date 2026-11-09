import type { ClientState } from "@openorc/client";
import type { CloudProvider } from "@openorc/protocol";
import { useEffect, useSyncExternalStore } from "react";
import type { ProjectChoice } from "../projects";

/** Where a new thread runs: on the Mac, as threads started there do, or in a sandbox of its own. */
export type ThreadPlace = "mac" | "cloud";

type ConversationSettings = ReturnType<ClientState["useConversationSettings"]>;

/**
 * What the model sheet reads and changes: a composer's model and Claude account, or an Orcling's. `claudeAccount` is
 * there for a new thread, for an open Claude thread, which can go on with another account between turns, and for an
 * Orcling, which runs on its own.
 */
export type ModelSettings = Pick<ConversationSettings, "choice" | "selectModel"> & {
  /** An existing thread's account, used for its model capabilities without offering an account change. */
  claudeAccountId?: string;
  /**
   * The account chosen here, undefined until one is: then the Mac's default runs. `held` says why it cannot change
   * now, and `failed` why the last change did not go through. `projectId` narrows the choice to the accounts that
   * project uses, when it uses only some.
   */
  claudeAccount?: { chosen: string | undefined; select: (id: string) => void; held?: string | null; failed?: string | null; projectId?: string };
};

/**
 * What the model, mode, account, place and project sheets read and change: an open thread's settings, or a new thread's
 * choices. Only a new thread has `place`, while the Mac offers cloud threads and the chosen agent runs there.
 */
export type ComposerSettings = ModelSettings &
  Pick<ConversationSettings, "mode" | "permission" | "selectExecutionMode"> & {
    place?: { chosen: ThreadPlace; provider: CloudProvider; select: (place: ThreadPlace) => void };
    /** A new thread's project picker; uploads and a pending start hold its selection. */
    project?: { chosen: string; choices: readonly ProjectChoice[]; disabled: boolean; select: (id: string) => void };
  };

/**
 * A composer's settings, for its picker sheets. A sheet is its own screen, but a choice made there must go
 * through the composer's one settings hook, so saves stay in order and a send waits for them. Each composer shares its
 * settings under its own id: the thread's id, or the new thread's.
 */
const shared = new Map<string, ModelSettings>();
const isComposer = (settings: ModelSettings): settings is ComposerSettings => "selectExecutionMode" in settings;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useShareSettings(composerId: string, settings: ModelSettings | ComposerSettings): void {
  useEffect(() => {
    shared.set(composerId, settings);
    listeners.forEach((listener) => listener());
  });
  useEffect(
    () => () => {
      shared.delete(composerId);
      listeners.forEach((listener) => listener());
    },
    [composerId],
  );
}

/** A composer's settings, for its mode, place and project sheets; an Orcling shares none. */
export function useSharedSettings(composerId: string): ComposerSettings | undefined {
  return useSyncExternalStore(subscribe, () => {
    const settings = shared.get(composerId);
    return settings && isComposer(settings) ? settings : undefined;
  });
}

/** What the model sheet changes: a composer's model and account, or an Orcling's. */
export function useSharedModelSettings(composerId: string): ModelSettings | undefined {
  return useSyncExternalStore(subscribe, () => shared.get(composerId));
}

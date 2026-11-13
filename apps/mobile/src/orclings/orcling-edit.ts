import { orclingHandle, type Orcling, type OrclingDraft, type OrclingProfile } from "@openorc/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import { useRpcMutation } from "../client";
import { haptic } from "../ui/haptics";

/** What a phone changes of an Orcling with `orclings.update`: what its designer on the Mac changes. */
export type OrclingEdit = Partial<Pick<OrclingDraft, "name" | "look" | "settings" | "permission" | "claudeAccountId">>;
type Saved = Pick<OrclingDraft, "name" | "look" | "settings" | "permission">;

/** The Mac's limit on an Orcling's name, in UTF-16 units as its schema counts them. */
export const NAME_MAX = 40;

/**
 * Why a name can't be saved, as the Mac's designer says it: too long, no letter or number, or another Orcling's,
 * whatever the case or punctuation. `others` are the other Orclings' names.
 */
export function nameProblem(name: string, others: readonly string[]): string | null {
  const typed = name.trim();
  if (!typed) return null;
  if (typed.length > NAME_MAX) return `A name is up to ${NAME_MAX} characters.`;
  const handle = orclingHandle(typed);
  if (!handle) return "A name needs a letter or a number.";
  const taken = others.find((other) => orclingHandle(other) === handle);
  return taken ? `You already have an Orcling named ${taken}.` : null;
}

/** The read `useRpc("orclings.profile", { id })` keeps, so a saved change shows before the Mac's refresh lands. */
export const profileKey = (id: string) => ["orclings.profile", { id }] as const;

/**
 * The draft `orclings.update` takes: `base` with the edit applied. The account goes only when it changes, so an
 * Orcling whose account the Mac stopped listing keeps it until another is picked.
 */
export function editedDraft(base: Saved, edit: OrclingEdit): OrclingDraft {
  const { name, look, settings, permission } = { ...base, ...edit };
  return { name, look, settings, permission, ...(edit.claudeAccountId ? { claudeAccountId: edit.claudeAccountId } : {}) };
}

/** Each Orcling's newest save, which the next waits for and builds on; null once one failed, so the next reads the Mac's. */
const queues = new Map<string, Promise<Saved | null>>();

/**
 * Sends `edit` once every earlier save of the same Orcling has answered, on top of what the last one saved, or of
 * `read()` when none waits. Each save is the whole draft, so two quick changes sent together would race on the Mac and
 * the later could undo the earlier.
 */
export function queueSave(id: string, edit: OrclingEdit, read: () => Saved | undefined, send: (draft: OrclingDraft) => Promise<Orcling>): Promise<Orcling> {
  const run = (queues.get(id) ?? Promise.resolve(null)).then((last) => {
    const base = last ?? read();
    if (!base) throw new Error("This Orcling hasn’t loaded yet.");
    return send(editedDraft(base, edit));
  });
  const tail = run.catch(() => null);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/** Settles once every save queued for the Orcling has answered, as deleting it must wait for. */
export const whenSaved = (id: string): Promise<void> => (queues.get(id) ?? Promise.resolve(null)).then(() => undefined);

/**
 * Changes one Orcling on its host: each change shows at once, is saved after the ones before it, and the Mac's answer
 * replaces it in the profile. What is shown stays until every save sent from here has answered, since one that answers
 * early holds an older value of a field a later one changes. A change the Mac refuses, such as a name another Orcling
 * has, goes back and an alert says why. `save` answers whether it was saved.
 */
export function useOrclingEdit(profile: OrclingProfile | undefined) {
  const queryClient = useQueryClient();
  const { mutateAsync } = useRpcMutation("orclings.update");
  const [pending, setPending] = useState<OrclingEdit>({});
  const unanswered = useRef(0);
  const id = profile?.id;
  const save = useCallback(
    (edit: OrclingEdit): Promise<boolean> => {
      if (!id) return Promise.resolve(false);
      setPending((before) => ({ ...before, ...edit }));
      unanswered.current++;
      return queueSave(
        id,
        edit,
        () => queryClient.getQueryData<OrclingProfile>(profileKey(id)),
        (draft) => mutateAsync({ id, draft }),
      )
        .then(
          ({ name, look, settings, permission, claudeAccountId }) => {
            queryClient.setQueryData<OrclingProfile>(profileKey(id), (shown) => shown && { ...shown, name, look, settings, permission, claudeAccountId });
            return true;
          },
          (failed: Error) => {
            haptic.warn();
            Alert.alert("Couldn’t save", failed.message);
            return false;
          },
        )
        .finally(() => {
          if (--unanswered.current === 0) setPending({});
        });
    },
    [id, mutateAsync, queryClient],
  );
  return { shown: profile && { ...profile, ...pending }, save };
}

import type { AgentSkill, SkillFileRead } from "@openorc/protocol";
import { useRpcMutation } from "../lib/client";
import { draftKey, showRead, type SkillDraft, type SkillDrafts } from "./settings-skills-data";
import { skillRef, type SkillsPlace } from "./settings-skills-model";

export interface SkillEditing {
  draft: SkillDraft | undefined;
  saving: boolean;
  error: string | null;
  begin: () => void;
  edit: (text: string) => void;
  save: () => void;
  cancel: () => void;
  /** After a conflict: save over the file as it is now. */
  keepMine: () => void;
  /** After a conflict: let the typed text go for the file as it is now. */
  takeCurrent: () => void;
}

/**
 * Editing one file of a skill. A save sends the version the edit started from; when the file changed since, the file
 * as it is now comes back, shows in the reading views, and the typed text stays in the editor until the user picks.
 */
export function useSkillEditing({ place, skill, file, read, drafts }: { place: SkillsPlace; skill: AgentSkill; file: string; read: SkillFileRead | undefined; drafts: SkillDrafts }): SkillEditing {
  const key = draftKey(skill, file);
  const draft = drafts.get(key);
  const write = useRpcMutation("skills.writeFile");
  const saving = write.isPending && write.variables?.file === file && write.variables.skill === skill.path;
  const save = () => {
    if (!draft || saving) return;
    write.mutate(
      { ...skillRef(place, skill), file, text: draft.text, expected: draft.base },
      {
        onSuccess: (result) => {
          if (result.kind === "saved") {
            showRead(place, skill, file, { kind: "text", text: draft.text, version: result.version, readOnly: null });
            drafts.drop(key);
            return;
          }
          showRead(place, skill, file, result.current);
          drafts.set(key, { ...draft, conflict: result.current });
        },
      },
    );
  };
  const conflict = draft?.conflict;
  return {
    draft,
    saving,
    error: draft ? (write.error?.message ?? null) : null,
    begin: () => {
      write.reset();
      if (read?.kind === "text") drafts.set(key, { base: read.version, original: read.text, text: read.text, conflict: null });
    },
    edit: (text) => {
      if (draft) drafts.set(key, { ...draft, text });
    },
    save,
    cancel: () => drafts.drop(key),
    keepMine: () => {
      if (draft && conflict?.kind === "text") drafts.set(key, { ...draft, base: conflict.version, original: conflict.text, conflict: null });
    },
    takeCurrent: () => {
      if (conflict?.kind === "text") drafts.set(key, { base: conflict.version, original: conflict.text, text: conflict.text, conflict: null });
      else drafts.drop(key);
    },
  };
}

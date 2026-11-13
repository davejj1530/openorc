import { useState } from "react";
import type { AgentSkill, FileVersion, SkillFileRead } from "@openorc/protocol";
import { queryClient, useRpcMutation } from "../lib/client";
import { listParams, skillRef, type SkillsPlace } from "./settings-skills-model";

type SkillPatch = Partial<Pick<AgentSkill, "enabled" | "icon">>;

const listKey = (place: SkillsPlace) => ["skills.list", listParams(place)];

/** Changes one skill in its agent's list as read, so the row and the detail agree before the next read. */
export function patchSkill(place: SkillsPlace, path: string, patch: SkillPatch): void {
  queryClient.setQueryData<AgentSkill[]>(listKey(place), (list) => list?.map((skill) => (skill.path === path ? { ...skill, ...patch } : skill)));
}

export function dropSkill(place: SkillsPlace, path: string): void {
  queryClient.setQueryData<AgentSkill[]>(listKey(place), (list) => list?.filter((skill) => skill.path !== path));
}

/** Records a file as it now is, so its views show it without reading it again. */
export function showRead(place: SkillsPlace, skill: AgentSkill, file: string, read: SkillFileRead): void {
  queryClient.setQueryData(["skills.readFile", { ...skillRef(place, skill), file }], read);
}

/** A skill's switch: it moves at once, and moves back when the agent refuses the change. */
export function useSkillSwitch(place: SkillsPlace, onProblem: (problem: string | null) => void) {
  const setEnabled = useRpcMutation("skills.setEnabled");
  return (skill: AgentSkill, enabled: boolean) => {
    onProblem(null);
    patchSkill(place, skill.path, { enabled });
    setEnabled.mutate(
      { ...skillRef(place, skill), enabled },
      {
        onSuccess: (result) => patchSkill(place, skill.path, { enabled: result.enabled }),
        onError: (error) => {
          patchSkill(place, skill.path, { enabled: !enabled });
          onProblem(error.message);
        },
      },
    );
  };
}

/**
 * A file being edited: the version the edit started from, its text then and now, and the file as it is on disk when a
 * save found it changed. The typed text stays until it is saved or let go, whatever the disk does.
 */
export interface SkillDraft {
  base: FileVersion;
  original: string;
  text: string;
  conflict: SkillFileRead | null;
}

export const draftKey = (skill: AgentSkill, file: string) => `${skill.path}\n${file}`;
export const isUnsaved = (draft: SkillDraft | undefined) => Boolean(draft && draft.text !== draft.original);

export interface SkillDrafts {
  get: (key: string) => SkillDraft | undefined;
  set: (key: string, draft: SkillDraft) => void;
  drop: (key: string) => void;
}

/** Every file being edited on the page, so a file's unsaved mark shows in the tree as well as over the editor. */
export function useSkillDrafts(): SkillDrafts {
  const [drafts, setDrafts] = useState<Record<string, SkillDraft>>({});
  return {
    get: (key) => drafts[key],
    set: (key, draft) => setDrafts((current) => ({ ...current, [key]: draft })),
    drop: (key) =>
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      }),
  };
}

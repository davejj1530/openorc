import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AgentSkill } from "@openorc/protocol";
import { skillsStatus } from "./settings-presentation";
import { LoadError } from "./settings-shared";
import { draftKey, isUnsaved, useSkillDrafts, useSkillSwitch } from "./settings-skills-data";
import { SkillDetail } from "./settings-skills-detail";
import { SkillList } from "./settings-skills-list";
import { groupSkills, mainFile, skillKey, type SkillGroup, type SkillsPlace } from "./settings-skills-model";

/** The list's count line: how many skills the agent has, how many the search keeps, or why there are none to count. */
function listStatus(list: UseQueryResult<AgentSkill[]>, groups: readonly SkillGroup[], search: string): string {
  const found = list.data ?? [];
  const count = found.length === 1 ? "1 skill" : `${found.length} skills`;
  if (list.data && search.trim()) return `${groups.reduce((sum, group) => sum + group.items.length, 0)} of ${count}`;
  return skillsStatus({ loading: list.isLoading, error: list.isError, found: found.length, success: list.isSuccess, count });
}

/** The chosen skill and file, else the first skill listed and its main file, so the detail is never empty while there are skills. */
function useSelection(skills: readonly AgentSkill[]) {
  const [chosen, setChosen] = useState<{ key: string; file: string | null } | null>(null);
  const selected = skills.find((skill) => skillKey(skill) === chosen?.key) ?? groupSkills(skills, "")[0]?.items[0] ?? null;
  const file = (selected && chosen?.key === skillKey(selected) && chosen.file) || (selected ? mainFile(selected) : "");
  return {
    selected,
    file,
    select: (skill: AgentSkill) => setChosen((current) => (current?.key === skillKey(skill) ? current : { key: skillKey(skill), file: null })),
    openFile: (next: string) => {
      if (selected) setChosen({ key: skillKey(selected), file: next });
    },
    added: (path: string) => setChosen({ key: path, file: null }),
  };
}

export function SkillsBrowser({ place, list }: { place: SkillsPlace; list: UseQueryResult<AgentSkill[]> }) {
  const skills = list.data ?? [];
  const [search, setSearch] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const drafts = useSkillDrafts();
  const toggle = useSkillSwitch(place, setProblem);
  const { selected, file, select, openFile, added } = useSelection(skills);
  const groups = groupSkills(skills, search);
  return (
    <>
      {list.isError ? <LoadError retry={() => void list.refetch()} /> : null}
      {problem ? (
        <p role="alert" className="text-sm text-bad mb-3">
          {problem}
        </p>
      ) : null}
      <div className="skills-browser">
        <SkillList
          place={place}
          groups={groups}
          status={listStatus(list, groups, search)}
          search={search}
          onSearch={setSearch}
          selected={selected}
          file={file}
          onSelect={select}
          onFile={openFile}
          onToggle={toggle}
          unsaved={(skill, path) => isUnsaved(drafts.get(draftKey(skill, path)))}
          onAdded={(path) => {
            added(path);
            setSearch("");
            void list.refetch();
          }}
        />
        {selected ? (
          <SkillDetail key={skillKey(selected)} place={place} skill={selected} file={file} drafts={drafts} onToggle={toggle} />
        ) : (
          <section className="skills-pane skill-detail-empty" data-plane="tile">
            {list.isSuccess ? "No skills yet" : null}
          </section>
        )}
      </div>
    </>
  );
}

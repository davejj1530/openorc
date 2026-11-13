import type { KeyboardEvent } from "react";
import type { AgentSkill } from "@openorc/protocol";
import { HeaderSearch } from "../components/PageFilters";
import { Switch } from "../components/ui";
import { AddSkillMenu } from "./settings-skills-add";
import { SkillBadge } from "./settings-skills-image";
import { skillKey, skillLine, skillTitle, type SkillGroup, type SkillsPlace } from "./settings-skills-model";
import { SkillFiles } from "./settings-skills-tree";

/** Moves focus through the rows and open files with the arrow keys; Right opens a folder and Left folds it. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-skills-nav]") : null;
  if (!item) return;
  const expanded = item.getAttribute("aria-expanded");
  if ((event.key === "ArrowRight" && expanded === "false") || (event.key === "ArrowLeft" && expanded === "true")) {
    event.preventDefault();
    item.click();
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-skills-nav]")].filter((each) => !each.closest("[hidden]"));
  const index = items.indexOf(item);
  const targets: Record<string, HTMLElement | undefined> = { ArrowDown: items[index + 1], ArrowUp: items[index - 1], Home: items[0], End: items.at(-1) };
  const target = targets[event.key];
  if (!target) return;
  event.preventDefault();
  target.focus();
}

interface SkillListProps {
  place: SkillsPlace;
  groups: SkillGroup[];
  status: string;
  search: string;
  onSearch: (search: string) => void;
  selected: AgentSkill | null;
  file: string;
  onSelect: (skill: AgentSkill) => void;
  onFile: (file: string) => void;
  onToggle: (skill: AgentSkill, enabled: boolean) => void;
  unsaved: (skill: AgentSkill, file: string) => boolean;
  onAdded: (skill: string) => void;
}

function SkillRow({ skill, current, props }: { skill: AgentSkill; current: boolean; props: SkillListProps }) {
  const title = skillTitle(skill);
  return (
    <li>
      <div className="skill-row" data-current={current || undefined} data-off={skill.enabled === false || undefined}>
        <button type="button" className="skill-row-main" data-skills-nav="" aria-current={current || undefined} onClick={() => props.onSelect(skill)}>
          <SkillBadge skill={skill} size="row" />
          <span className="skill-row-name">{title}</span>
          <span className="skill-row-line">{skillLine(skill)}</span>
        </button>
        {skill.enabled === undefined ? null : <Switch size="sm" aria-label={`Use ${title}`} checked={skill.enabled} onChange={(event) => props.onToggle(skill, event.target.checked)} />}
      </div>
      {skill.path ? <SkillFiles open={current} place={props.place} skill={skill} file={current ? props.file : ""} onFile={props.onFile} unsaved={(file) => props.unsaved(skill, file)} /> : null}
    </li>
  );
}

/** One agent's skills by where they come from, each with its switch; the selected one opens into its files. */
export function SkillList(props: SkillListProps) {
  const { groups } = props;
  const selected = props.selected ? skillKey(props.selected) : null;
  return (
    <section className="skills-pane skill-list-pane" aria-label="Skills">
      <div className="skill-list-head">
        <span role="status">{props.status}</span>
        <HeaderSearch label="Search skills" placeholder="Search" value={props.search} onChange={props.onSearch} />
        <AddSkillMenu place={props.place} onAdded={props.onAdded} />
      </div>
      <div className="skill-list-scroll" onKeyDown={moveFocus}>
        {groups.map((group) => (
          <div key={group.id} className="skill-group">
            <h3>{group.title}</h3>
            <ul>
              {group.items.map((skill) => (
                <SkillRow key={skillKey(skill)} skill={skill} current={skillKey(skill) === selected} props={props} />
              ))}
            </ul>
          </div>
        ))}
        {props.search && !groups.length ? <p className="skill-list-note">No skill matches.</p> : null}
      </div>
    </section>
  );
}

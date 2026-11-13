import { useState, type ReactNode } from "react";
import type { AgentSkill } from "@openorc/protocol";
import { Switch } from "../components/ui";
import { useRpc } from "../lib/client";
import { SkillActions } from "./settings-skills-actions";
import type { SkillDrafts } from "./settings-skills-data";
import { SkillFileView, type FileView } from "./settings-skills-file";
import { SkillImage } from "./settings-skills-image";
import {
  absoluteFolder,
  addedBy,
  mainFile,
  readableDescription,
  skillCall,
  skillFolder,
  skillRef,
  skillTitle,
  skillTrigger,
  triggerSettingsFile,
  type SkillsPlace,
  type SkillTrigger,
} from "./settings-skills-model";

/** How the skill starts, once the file that says so is read. A built-in has no such file, so it shows none. */
function useSkillTrigger(place: SkillsPlace, skill: AgentSkill): SkillTrigger | null {
  const file = skill.path ? triggerSettingsFile(place.agent, skill) : null;
  const read = useRpc("skills.readFile", { ...skillRef(place, skill), file: file ?? mainFile(skill) }, { enabled: place.active && file !== null });
  if (!skill.path) return null;
  if (file === null) return skillTrigger(place.agent, skill, "");
  if (!read.data) return null;
  return skillTrigger(place.agent, skill, read.data.kind === "text" ? read.data.text : "");
}

function TriggerText({ trigger }: { trigger: SkillTrigger }) {
  if (!trigger.call) return <>{trigger.auto ? "Auto" : "None"}</>;
  return (
    <>
      <span className="skill-call-text">{trigger.call}</span>
      {trigger.auto ? " + auto" : null}
    </>
  );
}

function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-tip={title}>{children}</dd>
    </div>
  );
}

function SkillFacts({ place, skill }: { place: SkillsPlace; skill: AgentSkill }) {
  const trigger = useSkillTrigger(place, skill);
  return (
    <dl className="skill-facts">
      <Fact label="Added by">{addedBy(skill)}</Fact>
      {trigger ? (
        <Fact label="Trigger">
          <TriggerText trigger={trigger} />
        </Fact>
      ) : null}
      {skill.path ? (
        <Fact label="Folder" title={absoluteFolder(skill)}>
          {skillFolder(skill)}
        </Fact>
      ) : null}
    </dl>
  );
}

interface DetailProps {
  place: SkillsPlace;
  skill: AgentSkill;
  file: string;
  drafts: SkillDrafts;
  onToggle: (skill: AgentSkill, enabled: boolean) => void;
}

function SkillHead({ place, skill, onToggle, onProblem }: Omit<DetailProps, "file" | "drafts"> & { onProblem: (problem: string | null) => void }) {
  const title = skillTitle(skill);
  const call = skillCall(place.agent, skill);
  return (
    <div className="skill-head">
      <SkillImage skill={skill} place={place} onProblem={onProblem} />
      <div className="skill-head-name">
        <h2>{title}</h2>
        {call ? <span className="skill-call-text">{call}</span> : null}
      </div>
      {skill.enabled === undefined ? null : <Switch size="sm" aria-label={`Use ${title}`} checked={skill.enabled} onChange={(event) => onToggle(skill, event.target.checked)} />}
      <SkillActions skill={skill} place={place} />
    </div>
  );
}

/** The selected skill: its image, name and call, where it comes from, how it starts, and the file chosen in its folder. */
export function SkillDetail({ place, skill, file, drafts, onToggle }: DetailProps) {
  const [view, setView] = useState<FileView>("preview");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="skills-pane skill-detail" aria-label={skillTitle(skill)}>
      <SkillHead place={place} skill={skill} onToggle={onToggle} onProblem={setProblem} />
      {problem ? (
        <p role="alert" className="text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <SkillFacts place={place} skill={skill} />
      <p className="skill-description">{readableDescription(skill.description)}</p>
      {skill.path ? <SkillFileView place={place} skill={skill} file={file} drafts={drafts} view={view} onView={setView} /> : null}
    </section>
  );
}

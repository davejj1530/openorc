import { Menu } from "@base-ui/react/menu";
import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { harnessCatalog, harnessIds, type AgentSkill, type HarnessId, type Project } from "@openorc/protocol";
import { HarnessLogo } from "../components/HarnessLogo";
import { Check, ChevronDown, Folder, RefreshCw } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { IconButton, Segmented } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { focusedProject, useLayout } from "../lib/layout";
import { floatingGround } from "../lib/use-anchor-ground";
import { projectSkillsPlaceholder } from "./settings-presentation";
import { LoadError, SectionActions } from "./settings-shared";
import { SkillsBrowser } from "./settings-skills-browser";
import "./settings-skills.css";

type SkillList = UseQueryResult<AgentSkill[]>;

function agentOptions(lists: Record<HarnessId, SkillList>) {
  return harnessIds.map((id) => ({
    value: id,
    label: (
      <>
        <HarnessLogo id={id} size={14} />
        {harnessCatalog[id].name}
        {lists[id].data ? <span className="skills-agent-count">{lists[id].data.length}</span> : null}
      </>
    ),
  }));
}

function ProjectChoice({ projects, projectId, error, onProject }: { projects: Project[] | undefined; projectId: string; error: boolean; onProject: (id: string) => void }) {
  const name = projects?.find((project) => project.id === projectId)?.name ?? projectSkillsPlaceholder(error, Boolean(projects));
  return (
    <Menu.Root>
      <Menu.Trigger className="skills-project" aria-label={`Project, ${name}`} disabled={!projects?.length}>
        <Folder size={14} />
        <span className="truncate">{name}</span>
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            <Menu.RadioGroup aria-label="Project" value={projectId} onValueChange={(id: string) => onProject(id)}>
              {projects?.map((project) => (
                <Menu.RadioItem key={project.id} value={project.id} className={menuItem} closeOnClick>
                  <Check size={13} className={cn("text-transparent", project.id === projectId && "text-ink")} />
                  <span className="truncate">{project.name}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Every agent's skills read together, so each count shows before its agent is chosen. */
function useSkillLists(projectId: string, enabled: boolean): Record<HarnessId, SkillList> {
  const scope = { kind: "project" as const, id: projectId };
  // Settings keeps its other panels mounted, so reading skills, which starts each agent's CLI, waits for this one.
  const options = { enabled, staleTime: 60_000 };
  const codex = useRpc("skills.list", { scope, agent: "codex" }, options);
  const claude = useRpc("skills.list", { scope, agent: "claude" }, options);
  const opencode = useRpc("skills.list", { scope, agent: "opencode" }, options);
  return { codex, claude, opencode };
}

/** Each agent's skills in one project: a list to switch them on and off, and the chosen one's files to read and edit. */
export function SkillsSettings({ active }: { active: boolean }) {
  const projects = useRpc("projects.list", {});
  // Settings is a global surface and the rail can be on every project at once,
  // so the rail seeds this choice rather than being it. Only the project tier
  // depends on which project it is, and picking it here says which one that was.
  const railProject = useLayout(focusedProject);
  const [projectId, setProjectId] = useState(railProject ?? "");
  const [agent, setAgent] = useState<HarnessId>("codex");
  useEffect(() => {
    const first = projects.data?.[0];
    if (!projectId && first) setProjectId(first.id);
  }, [projects.data, projectId]);
  const lists = useSkillLists(projectId, active && Boolean(projectId));
  const refreshing = harnessIds.some((id) => lists[id].isFetching);
  return (
    <div className="skills-page">
      <SectionActions active={active}>
        <Segmented label="Agent" value={agent} options={agentOptions(lists)} onChange={setAgent} />
        <IconButton aria-label="Refresh skills" disabled={refreshing} onClick={() => harnessIds.forEach((id) => void lists[id].refetch())}>
          <RefreshCw size={14} />
        </IconButton>
        <ProjectChoice projects={projects.data} projectId={projectId} error={projects.isError} onProject={setProjectId} />
      </SectionActions>
      {projects.isError ? <LoadError retry={() => void projects.refetch()} /> : null}
      {projects.isSuccess && projectId === "" ? <p className="settings-note">Import a project and OpenOrc will list the skills it can resolve there.</p> : null}
      {projectId ? <SkillsBrowser key={projectId} place={{ agent, scope: { kind: "project", id: projectId }, projectId, active }} list={lists[agent]} /> : null}
    </div>
  );
}

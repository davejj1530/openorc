import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { WORKSPACE_ID } from "@openorc/protocol";
import { Check, Globe, Plus, Search } from "./icons";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectMenu } from "./ProjectMenu";
import { CoversPreview } from "../lib/browser-preview";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";

type PickerProject = { id: string; name: string; rootPath?: string };

/** A long list gains a filter; a short one reads at a glance. */
const FILTER_FROM = 8;

function projectLabel(project: PickerProject): string {
  return project.id === WORKSPACE_ID ? "Workspace" : project.name;
}

function ProjectOption({ project, selected, onSelect }: { project: PickerProject; selected: boolean; onSelect: () => void }) {
  const contents = (
    <>
      {project.rootPath && project.id !== WORKSPACE_ID ? (
        <ProjectIconPicker rootPath={project.rootPath} name={projectLabel(project)} />
      ) : (
        <span className="project-option-icon">
          <Globe size={16} />
        </span>
      )}
      <button className="project-option-name" onClick={onSelect} aria-pressed={selected}>
        <span>{projectLabel(project)}</span>
        {selected ? <Check size={14} /> : null}
      </button>
    </>
  );
  return (
    <div className="project-option" data-selected={selected}>
      {project.id !== WORKSPACE_ID ? <ProjectMenu project={{ id: project.id, name: project.name }}>{contents}</ProjectMenu> : <div className="flex items-center gap-1 h-8 pl-1 pr-1">{contents}</div>}
    </div>
  );
}

/** The new thread's question, its project the switch. */
export function NewThreadQuestion({
  projectId,
  projects,
  disabled,
  onProject,
}: {
  projectId: string;
  projects: readonly PickerProject[] | undefined;
  disabled: boolean;
  onProject: (id: string) => void;
}) {
  return (
    <h1 className="new-thread-question">
      What should we work on in{" "}
      <span className="new-thread-question-name">
        <ProjectPicker projectId={projectId} projects={projects} disabled={disabled} onProject={onProject} />?
      </span>
    </h1>
  );
}

/**
 * Where a new thread starts, named in the question above its composer. The name opens every project, each with its
 * icon chooser and, on right-click, removal; then Add project.
 */
export function ProjectPicker({
  projectId,
  projects,
  disabled = false,
  onProject,
}: {
  projectId: string;
  projects: readonly PickerProject[] | undefined;
  disabled?: boolean;
  onProject: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const options = projects ?? [];
  const current = options.find((project) => project.id === projectId);
  let name = projects ? "Choose project" : "…";
  if (current) name = projectLabel(current);
  const typed = filter.trim().toLowerCase();
  const shown = typed ? options.filter((project) => projectLabel(project).toLowerCase().includes(typed)) : options;
  const filterable = options.length >= FILTER_FROM;
  const choose = (id: string) => {
    onProject(id);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setFilter("");
      }}
    >
      <Popover.Trigger aria-label={`Project: ${name}`} className="new-thread-question-project" disabled={disabled || !options.length}>
        {name}
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="bottom" sideOffset={8} align="start" className="z-40" collisionPadding={8}>
          <Popover.Popup ref={floatingGround} className="project-picker-popup" aria-label="Choose project" initialFocus={filterable ? field : undefined}>
            {filterable ? (
              <label className="project-picker-filter">
                <Search size={15} />
                <input
                  ref={field}
                  value={filter}
                  placeholder="Find a project"
                  aria-label="Find a project"
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !shown[0]) return;
                    // The composer takes focus as the list closes; the key must not type into it.
                    event.preventDefault();
                    choose(shown[0].id);
                  }}
                />
              </label>
            ) : null}
            <div className="project-picker-options">
              {shown.map((project) => (
                <ProjectOption key={project.id} project={project} selected={projectId === project.id} onSelect={() => choose(project.id)} />
              ))}
              {typed && !shown.length ? <p className="project-picker-feedback">No matching projects</p> : null}
            </div>
            <button
              className="project-picker-add"
              onClick={() => {
                setOpen(false);
                useUi.getState().setImportProject(true);
              }}
            >
              <Plus size={15} />
              Add project
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

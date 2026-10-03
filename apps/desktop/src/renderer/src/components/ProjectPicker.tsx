import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { WORKSPACE_ID } from "@openorc/protocol";
import { Check, ChevronDown, Folder, Globe, SquareStack, Plus } from "./icons";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectMenu } from "./ProjectMenu";
import { Tooltip } from "./ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/query";
import { useUi } from "../lib/ui";

type PickerProject = { id: string | null; name: string; rootPath?: string };

function ProjectOption({ project, selected, onSelect }: { project: PickerProject; selected: boolean; onSelect: () => void }) {
  const contents = (
    <>
      {project.rootPath ? (
        <ProjectIconPicker rootPath={project.rootPath} name={project.name} />
      ) : (
        <span className="project-option-icon">{project.id === null ? <SquareStack size={16} /> : <Globe size={16} />}</span>
      )}
      <button className="project-option-name" onClick={onSelect} aria-pressed={selected}>
        <span>{project.name}</span>
        {selected ? <Check size={14} /> : null}
      </button>
    </>
  );
  return (
    <div className="project-option" data-selected={selected}>
      {project.id && project.id !== WORKSPACE_ID ? (
        <ProjectMenu project={{ id: project.id, name: project.name }}>{contents}</ProjectMenu>
      ) : (
        <div className="flex items-center gap-1 h-8 pl-1 pr-1">{contents}</div>
      )}
    </div>
  );
}

/** Project selection is a temporary popover, not a second navigation column. */
export function ProjectPicker({ projectId, onProject, compact = false }: { projectId: string | null; onProject: (id: string | null) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const projects = useRpc("projects.list", {});
  const options: PickerProject[] = [{ id: null, name: "All projects" }, { id: WORKSPACE_ID, name: "Workspace" }, ...(projects.data ?? [])];
  const selected = options.find((option) => option.id === projectId)?.name ?? "Projects";
  const trigger = (
    <Popover.Trigger aria-label={`Projects: ${selected}`} className={compact ? "workspace-rail-button" : "thread-project-picker"}>
      {compact ? (
        <Folder size={19} />
      ) : (
        <>
          <span>{selected}</span>
          <ChevronDown size={15} />
        </>
      )}
    </Popover.Trigger>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {compact ? <Tooltip label={`Projects · ${selected}`}>{trigger}</Tooltip> : trigger}
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side={compact ? "right" : "bottom"} sideOffset={8} align="start" className="z-40" collisionPadding={8}>
          <Popover.Popup className="project-picker-popup" aria-label="Choose project">
            <div className="project-picker-label">Projects</div>
            <div className="project-picker-options">
              {options.map((project) => (
                <ProjectOption
                  key={project.id ?? "all"}
                  project={project}
                  selected={projectId === project.id}
                  onSelect={() => {
                    onProject(project.id);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
            {projects.isLoading ? <p className="project-picker-feedback">Loading projects…</p> : null}
            {projects.isError ? (
              <button className="project-picker-feedback" onClick={() => void projects.refetch()}>
                Couldn’t load projects. Retry
              </button>
            ) : null}
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

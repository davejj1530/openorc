import { useId, useRef, useState } from "react";
import { WORKSPACE_ID, type Project } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { useLayout } from "../lib/layout";
import { Globe, Search, X } from "./icons";
import { ProjectIcon } from "./ProjectIconPicker";
import { Button, Dialog, IconButton, Switch } from "./ui";
import "./SidebarProjectVisibility.css";

type VisibilityProject = Pick<Project, "id" | "name"> & { rootPath: string | undefined };

function ProjectVisibilityRow({
  project,
  shown,
  only,
  busy,
  onShown,
  onOnly,
}: {
  project: VisibilityProject;
  shown: boolean;
  only: boolean;
  busy: boolean;
  onShown: (shown: boolean) => void;
  onOnly: () => void;
}) {
  const id = useId();
  return (
    <div className="project-visibility-row" data-hidden={!shown || undefined}>
      <label className="project-visibility-label" htmlFor={id}>
        <span className="project-visibility-icon" aria-hidden="true">
          {project.rootPath ? <ProjectIcon rootPath={project.rootPath} /> : <Globe size={18} />}
        </span>
        <span className="project-visibility-details">
          <span className="project-visibility-name" title={project.name}>
            {project.name}
          </span>
          <span className="project-visibility-path" title={project.rootPath} aria-hidden="true">
            {project.rootPath ?? "Direct conversations"}
          </span>
        </span>
      </label>
      <Button variant="ghost" size="sm" className="project-visibility-only" aria-label={`Show only ${project.name}`} disabled={busy || only} onClick={onOnly}>
        Only
      </Button>
      <Switch id={id} aria-label={project.name} checked={shown} onChange={(event) => onShown(event.target.checked)} />
    </div>
  );
}

/** The projects whose threads the sidebar lists. All projects start visible. */
export function SidebarProjectVisibility({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useRpc("projects.list", {}, { enabled: open });
  const hidden = useLayout((s) => s.hiddenProjects);
  const setShown = useLayout((s) => s.setProjectShown);
  const setAllShown = useLayout((s) => s.setProjectsShown);
  const showOnly = useLayout((s) => s.showOnlyProject);
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const options: VisibilityProject[] = [{ id: WORKSPACE_ID, name: "Workspace", rootPath: undefined }, ...(projects.data ?? [])];
  const ids = options.map((project) => project.id);
  const shown = options.filter((project) => !hidden.includes(project.id)).length;
  const busy = Boolean(projects.isPending || projects.isError);
  const query = search.trim().toLowerCase();
  const matches = options.filter((project) => `${project.name} ${project.rootPath ?? ""}`.toLowerCase().includes(query));
  const changeOpen = (next: boolean) => {
    if (!next) setSearch("");
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen} title="Edit projects" width={360}>
      <div className="project-visibility">
        <div className="project-visibility-search">
          <Search size={14} />
          <input ref={input} autoFocus aria-label="Find a project" placeholder="Find a project…" value={search} onChange={(event) => setSearch(event.target.value)} />
          {search ? (
            <IconButton
              size="xs"
              aria-label="Clear project search"
              onClick={() => {
                setSearch("");
                input.current?.focus();
              }}
            >
              <X size={13} />
            </IconButton>
          ) : null}
        </div>
        <div className="project-visibility-toolbar">
          <span className="tabular">
            {shown} of {options.length} shown
          </span>
          <div className="project-visibility-bulk">
            <Button variant="ghost" size="sm" disabled={busy || shown === options.length} onClick={() => setAllShown(ids, true)}>
              Show all
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || shown === 0} onClick={() => setAllShown(ids, false)}>
              Hide all
            </Button>
          </div>
        </div>
        <div className="project-visibility-list">
          {matches.map((project) => (
            <ProjectVisibilityRow
              key={project.id}
              project={project}
              shown={!hidden.includes(project.id)}
              only={shown === 1 && !hidden.includes(project.id)}
              busy={busy}
              onShown={(next) => setShown(project.id, next)}
              onOnly={() => showOnly(project.id, ids)}
            />
          ))}
          {!busy && matches.length === 0 ? (
            <p className="project-visibility-feedback" role="status">
              No projects found.
            </p>
          ) : null}
          {projects.isPending ? <p className="project-visibility-feedback">Loading projects…</p> : null}
          {projects.isError ? (
            <button className="project-visibility-feedback" onClick={() => void projects.refetch()}>
              Couldn’t load projects. Retry
            </button>
          ) : null}
        </div>
        <div className="project-visibility-footer">
          <Button variant="primary" size="lg" onClick={() => changeOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

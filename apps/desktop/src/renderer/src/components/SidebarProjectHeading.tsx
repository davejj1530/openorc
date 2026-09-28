import { WORKSPACE_ID } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { newThread } from "../lib/router";
import { ChevronDown, ChevronRight, Folder, Globe, Plus } from "./icons";
import { IconButton, Tooltip } from "./ui";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectMenu, projectHeadingClassName } from "./ProjectMenu";

export function SidebarProjectHeading({ group, expanded }: { group: { id: string; name: string; rootPath?: string }; expanded: boolean }) {
  const toggleCollapsed = useLayout((state) => state.toggleCollapsed);
  const setProject = useLayout((state) => state.setProject);
  const heading = (
    <>
      {group.id !== WORKSPACE_ID && group.rootPath ? (
        <ProjectIconPicker rootPath={group.rootPath} name={group.name} />
      ) : (
        <span className="inline-flex size-6 shrink-0 items-center justify-center">
          {group.id === WORKSPACE_ID ? <Globe size={14} className="text-ink-3" /> : <Folder size={16} className="text-ink-3" />}
        </span>
      )}
      <button
        className="no-drag flex-1 min-w-0 flex items-center gap-1.5 h-8 pr-1 rounded-md text-md font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
        aria-expanded={expanded}
        aria-controls={`project-threads-${group.id}`}
        onClick={() => toggleCollapsed(`project:${group.id}`)}
        title={group.name}
      >
        <span className="truncate text-left">{group.name}</span>
        {expanded ? <ChevronDown size={12} className="shrink-0 text-ink-3" /> : <ChevronRight size={12} className="shrink-0 text-ink-3" />}
      </button>
      <Tooltip label={`New thread in ${group.name}`}>
        <IconButton
          aria-label={`New thread in ${group.name}`}
          size="sm"
          className="sidebar-project-add no-drag shrink-0"
          onClick={() => {
            setProject(group.id);
            if (!expanded) toggleCollapsed(`project:${group.id}`);
            newThread(group.id);
          }}
        >
          <Plus size={13} />
        </IconButton>
      </Tooltip>
    </>
  );
  if (group.id === WORKSPACE_ID) return <div className={projectHeadingClassName}>{heading}</div>;
  return <ProjectMenu project={group}>{heading}</ProjectMenu>;
}

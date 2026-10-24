import { useId, useState, type ReactNode } from "react";
import { useLayout } from "../lib/layout";
import { WORKSPACE_ID } from "@openorc/protocol";
import { newThread } from "../lib/router";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import type { ProjectMeta } from "@openorc/client";
import { Globe, Plus } from "./icons";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectMenu } from "./ProjectMenu";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";

/**
 * A project heading and its threads. The heading says what matters most about the project (it needs you, threads
 * running, or how many it lists), swapping to a project-scoped New thread on hover and focus. A folded project still
 * reports its activity.
 */
export function SidebarProjectGroup({ id, name, rootPath, meta, children }: { id: string; name: string; rootPath?: string; meta: ProjectMeta | null; children: ReactNode }) {
  const collapsed = useLayout((state) => state.collapsed);
  const toggle = useLayout((state) => state.toggleCollapsed);
  const contentId = useId();
  const expanded = !collapsed.includes(`project:${id}`);
  // Only a fold the user opens animates; loads and remounts show the list in place.
  const [animate, setAnimate] = useState(false);
  const header = (
    <>
      {rootPath ? <ProjectIconPicker rootPath={rootPath} name={name} expanded={expanded} /> : <Globe size={16} className="project-group-icon" />}
      <button
        type="button"
        className="browser-group-toggle no-drag"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${name} threads`}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => {
          setAnimate(true);
          toggle(`project:${id}`);
        }}
      >
        <span className="truncate">{name}</span>
      </button>
      <span className="project-group-end" data-meta={meta ? true : undefined}>
        {meta ? (
          <span className="project-group-activity" data-tone={meta.tone}>
            {meta.text}
          </span>
        ) : null}
        <Tooltip label={`New thread in ${name}`}>
          <IconButton
            size="xs"
            aria-label={`New thread in ${name}`}
            className="project-group-new no-drag"
            onClick={() => {
              useLayout.getState().setProject(id);
              newThread(id);
              dismissCompactNavigation();
            }}
          >
            <Plus size={14} />
          </IconButton>
        </Tooltip>
      </span>
    </>
  );
  return (
    <section className="sidebar-project" aria-label={`${name} threads`}>
      <div className="browser-group-title">{id === WORKSPACE_ID ? <div className="project-heading">{header}</div> : <ProjectMenu project={{ id, name }}>{header}</ProjectMenu>}</div>
      <div id={contentId} className={cn("sidebar-project-threads", animate && "motion-stagger")} data-animate={animate || undefined} inert={!expanded} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}

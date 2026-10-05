import { useId, type ReactNode } from "react";
import { useLayout } from "../lib/layout";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { newThread } from "../lib/router";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { ChevronDown, ChevronRight, Globe, Plus } from "./icons";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { ProjectMenu } from "./ProjectMenu";
import { IconButton, Tooltip } from "./ui";

/** A folded project still shows known activity and offers a project-scoped new thread. */
export function SidebarProjectGroup({ id, name, rootPath, threads, children }: { id: string; name: string; rootPath?: string; threads: readonly ThreadSummary[]; children: ReactNode }) {
  const collapsed = useLayout((state) => state.collapsed);
  const toggle = useLayout((state) => state.toggleCollapsed);
  const contentId = useId();
  const expanded = !collapsed.includes(`project:${id}`);
  const waiting = threads.some((thread) => thread.activity === "waiting");
  const running = threads.some((thread) => thread.activity === "running");
  const header = (
    <>
      {rootPath ? <ProjectIconPicker rootPath={rootPath} name={name} /> : <Globe size={14} className="project-group-icon" />}
      <button
        type="button"
        className="browser-group-toggle"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${name} threads`}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => toggle(`project:${id}`)}
      >
        <span className="truncate">{name}</span>
        {waiting || running ? (
          <span className="project-group-activity" data-waiting={waiting || undefined}>
            {waiting ? "Needs you" : "Running"}
          </span>
        ) : null}
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <Tooltip label={`New thread in ${name}`}>
        <IconButton
          size="sm"
          aria-label={`New thread in ${name}`}
          onClick={() => {
            useLayout.getState().setProject(id);
            newThread(id);
            dismissCompactNavigation();
          }}
        >
          <Plus size={14} />
        </IconButton>
      </Tooltip>
    </>
  );
  return (
    <section className="sidebar-project" aria-label={`${name} threads`}>
      <div className="browser-group-title">
        {id === WORKSPACE_ID ? <div className="flex items-center gap-1 h-8 pl-1 pr-1">{header}</div> : <ProjectMenu project={{ id, name }}>{header}</ProjectMenu>}
      </div>
      <div id={contentId} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}

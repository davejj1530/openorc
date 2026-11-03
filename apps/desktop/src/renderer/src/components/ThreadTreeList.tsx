import type { ThreadSummary } from "@openorc/protocol";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { threadAncestors, threadSearchFolds, threadBranchPath, threadChildren, threadTreeRows, type ThreadTreeRow } from "@openorc/client";
import { useLayout } from "../lib/layout";
import { ChevronRight } from "./icons";
import { ThreadRow } from "./ThreadLibraryRow";

export function ThreadTreeList({
  roots,
  all,
  activeId,
  projectNames,
  search = "",
}: {
  roots: ThreadSummary[];
  all: ThreadSummary[];
  activeId: string | null;
  projectNames?: ReadonlyMap<string, string>;
  search?: string;
}) {
  const saved = useLayout((state) => state.collapsed);
  const toggle = useLayout((state) => state.toggleThreadChildren);
  const reveal = all.filter((thread) => thread.id === activeId || (search && thread.title.toLowerCase().includes(search.toLowerCase()))).map((thread) => thread.id);
  const ancestorsKey = JSON.stringify([...threadAncestors(all, activeId ? [activeId] : [])].sort());
  useLayoutEffect(() => {
    useLayout.getState().revealThreads(JSON.parse(ancestorsKey) as string[]);
  }, [activeId, ancestorsKey]);
  const rows = new Map(threadTreeRows(roots, all, threadSearchFolds(saved, all, search), reveal).map((row) => [row.thread.id, row]));
  const children = threadChildren(all);
  const visited = new Set<string>();
  const render = (thread: ThreadSummary): ReactNode => {
    const row = rows.get(thread.id);
    if (!row || visited.has(thread.id)) return null;
    visited.add(thread.id);
    const { depth, hasChildren, expanded } = row;
    const projectName = depth ? undefined : projectNames?.get(thread.projectId);
    return (
      <div key={thread.id} className="sidebar-tree-node" data-child={depth > 0 || undefined}>
        <BranchRow row={row} projectName={projectName}>
          {hasChildren ? (
            <button className="sidebar-tree-toggle no-drag" aria-label={`${expanded ? "Collapse" : "Expand"} ${thread.title}`} aria-expanded={expanded} onClick={() => toggle(thread.id, expanded)}>
              <ChevronRight size={12} className={expanded ? "work-chevron rotate-90" : "work-chevron"} />
            </button>
          ) : (
            <span className="sidebar-tree-spacer" />
          )}
          <ThreadRow thread={thread} active={activeId === thread.id} compact={depth > 0} projectName={projectName} />
        </BranchRow>
        {expanded && hasChildren ? (
          <div className="sidebar-tree-children" data-capped={depth >= 3 || undefined}>
            {children.get(thread.id)?.map(render)}
          </div>
        ) : null}
      </div>
    );
  };
  return roots.map(render);
}

function BranchRow({ row, projectName, children }: { row: ThreadTreeRow; projectName?: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ height: projectName ? 52 : 34, mid: projectName ? 35 : 17 });
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      const mark = node.querySelector(".thread-preview-status")?.getBoundingClientRect();
      const scale = bounds.height / node.offsetHeight;
      if (mark && scale) setSize({ height: node.offsetHeight, mid: (mark.top - bounds.top + mark.height / 2) / scale });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  const indent = Math.min(row.depth, 3) * 20;
  return (
    <div ref={element} className="sidebar-tree-item">
      {children}
      <svg aria-hidden className="sidebar-tree-lines" style={{ left: -indent }} width={34 + indent} height={size.height}>
        <path d={threadBranchPath(row, { markX: 34, ...size })} />
      </svg>
    </div>
  );
}

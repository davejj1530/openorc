import type { ThreadSummary } from "@openorc/protocol";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { threadAncestors, threadBranchPath, threadPageBranchPath, threadChildren, threadTreeRows, type ThreadTreeRow } from "@openorc/client";
import { useLayout } from "../lib/layout";
import { ChevronDown } from "./icons";
import { ThreadRow, type RowProject } from "./ThreadLibraryRow";

export function ThreadTreeList({
  roots,
  all,
  activeId,
  projects,
  childLimits,
  onShowMore,
}: {
  roots: ThreadSummary[];
  all: ThreadSummary[];
  activeId: string | null;
  projects?: ReadonlyMap<string, RowProject>;
  childLimits?: Readonly<Record<string, number>>;
  onShowMore?: (projectId: string, parentId: string) => void;
}) {
  const saved = useLayout((state) => state.collapsed);
  const toggle = useLayout((state) => state.toggleThreadChildren);
  const ancestorsKey = JSON.stringify([...threadAncestors(all, activeId ? [activeId] : [])].sort());
  useLayoutEffect(() => {
    useLayout.getState().revealThreads(JSON.parse(ancestorsKey) as string[]);
  }, [activeId, ancestorsKey]);
  const rows = new Map(threadTreeRows(roots, all, saved, activeId ? [activeId] : [], childLimits).map((row) => [row.thread.id, row]));
  const children = threadChildren(all);
  const visited = new Set<string>();
  const render = (thread: ThreadSummary): ReactNode => {
    const row = rows.get(thread.id);
    if (!row || visited.has(thread.id)) return null;
    visited.add(thread.id);
    const { depth, hasChildren, expanded } = row;
    const project = depth ? undefined : projects?.get(thread.projectId);
    return (
      <div key={thread.id} className="sidebar-tree-node" data-child={depth > 0 || undefined}>
        <BranchRow row={row} project={Boolean(project)} onToggle={hasChildren ? () => toggle(thread.id, expanded) : undefined}>
          <ThreadRow thread={thread} active={activeId === thread.id} compact={depth > 0} project={project} />
        </BranchRow>
        {expanded && hasChildren ? (
          <div className="sidebar-tree-children" data-capped={depth >= 3 || undefined}>
            {children.get(thread.id)?.map(render)}
            {row.hiddenChildren ? (
              <BranchRow row={row} paging>
                <button className="browser-load-more" aria-label={`Show ${row.hiddenChildren} more in ${thread.title}`} onClick={() => onShowMore?.(thread.projectId, thread.id)}>
                  Show {row.hiddenChildren} more
                </button>
              </BranchRow>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };
  return roots.map(render);
}

/** The tree's grid: a parent's line leaves its project icon, and a sub thread steps in so its mark sits under the project's name. */
const MARK_X = 18;
const STEP = 24;

/**
 * A row of the tree with its share of the branch lines drawn over its lead. A parent carries its disclosure at the end
 * of its title line, where the phone keeps it: the chevron points down while its sub threads are folded and turns up
 * as they open.
 */
function BranchRow({ row, project = false, children, paging = false, onToggle }: { row: ThreadTreeRow; project?: boolean; children: ReactNode; paging?: boolean; onToggle?: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ height: project ? 52 : 34, mid: project ? 35 : 17, title: 17 });
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      const scale = bounds.height / node.offsetHeight;
      const center = (part: Element | null) => {
        const box = part?.getBoundingClientRect();
        return box ? (box.top - bounds.top + box.height / 2) / scale : node.offsetHeight / 2;
      };
      if (scale)
        setSize({
          height: node.offsetHeight,
          mid: center(node.querySelector(".thread-preview-project-icon") ?? node.querySelector(".thread-preview-status")),
          title: center(node.querySelector(".thread-preview-heading")),
        });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  const indent = Math.min(row.depth + Number(paging), 3) * STEP;
  return (
    <div ref={element} className="sidebar-tree-item" data-parent={onToggle ? true : undefined} data-subagents-start={(!paging && row.subagentsStart) || undefined}>
      {children}
      {onToggle ? (
        <button
          className="sidebar-tree-toggle no-drag"
          style={{ top: size.title - 12 }}
          aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.thread.title}`}
          aria-expanded={row.expanded}
          onClick={onToggle}
        >
          <ChevronDown size={14} className={row.expanded ? "work-chevron rotate-180" : "work-chevron"} />
        </button>
      ) : null}
      <svg aria-hidden className="sidebar-tree-lines" style={{ left: -indent }} width={MARK_X + 16 + indent} height={size.height}>
        <path d={(paging ? threadPageBranchPath : threadBranchPath)(row, { markX: MARK_X, step: STEP, mid: size.mid, height: size.height })} />
      </svg>
    </div>
  );
}

import { useState, type ReactNode, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectIconState } from "../../../shared/project-icons";
import { PROJECT_STACK_LABELS, type ProjectStackIconId } from "../../../shared/project-stack-icons";
import { projectIconKey, useProjectIcon } from "../lib/project-icons";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { menuItem } from "./menu";
import { Folder, FolderOpen, Check } from "./icons";
import { Button, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { ProjectStackIcon } from "./ProjectStackIcon";

function IconImage({ source, fallback, expanded, size = 16 }: { source: string | undefined; fallback?: ProjectStackIconId | null; expanded?: boolean; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!source || failed === source) {
    if (fallback) return <ProjectStackIcon id={fallback} size={size} className="shrink-0" />;
    return expanded ? <FolderOpen size={size} className="shrink-0" /> : <Folder size={size} className="shrink-0" />;
  }
  return <img src={source} alt="" width={size} height={size} style={{ width: size, height: size }} className="shrink-0 object-contain" onError={() => setFailed(source)} />;
}

/** The same project artwork as the sidebar, without opening the icon chooser; 16px unless `size` says otherwise. */
export function ProjectIcon({ rootPath, size }: { rootPath: string; size?: number }) {
  const { data: state } = useProjectIcon(rootPath);
  return <IconImage source={state?.selected?.dataUrl} fallback={state?.mode === "auto" ? state.fallback : null} {...(size ? { size } : {})} />;
}

function DiscoveryStatus({ loading, state }: { loading: boolean; state: ProjectIconState | undefined }) {
  if (loading)
    return (
      <p role="status" className="px-2.5 pt-2 text-sm text-ink-3">
        Looking for icons…
      </p>
    );
  if (state?.fallback) return <p className="px-2.5 pt-2 text-sm text-ink-3">Detected {PROJECT_STACK_LABELS[state.fallback]}. Automatic uses its icon when no repository image is selected.</p>;
  if (state?.candidates.length === 0) return <p className="px-2.5 pt-2 text-sm text-ink-3">No suitable icons found in this repository.</p>;
  return null;
}

/**
 * The popover that chooses a project's icon: its folder, the images found in its repository, any image file, Refresh,
 * and Automatic. It opens from `children`, a trigger, or beside `anchor` when something else opens it.
 */
export function ProjectIconChooser({
  rootPath,
  open,
  onOpenChange,
  anchor,
  children,
}: {
  rootPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor?: RefObject<Element | null>;
  children?: ReactNode;
}) {
  const icons = useProjectIcon(rootPath);
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = window.openorc?.projectIcons;
  const state = icons.data;
  const busy = pending || icons.isFetching;
  const perform = async (action: () => Promise<ProjectIconState | null>, close = true) => {
    setPending(true);
    setError(null);
    try {
      const next = await action();
      if (next) {
        client.setQueryData(projectIconKey(rootPath), next);
        if (close) onOpenChange(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the project icon.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {children}
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="right" align="start" sideOffset={8} className="z-50" {...(anchor ? { anchor } : {})}>
          <Popover.Popup ref={floatingGround} className="floating-popover w-72">
            <Popover.Title className="floating-popover-title">Project icon</Popover.Title>
            <div className="flex flex-col gap-0.5">
              <button disabled={busy || !api} onClick={() => void perform(() => api.choose(rootPath, { mode: "folder" }))} className={menuItem}>
                <Folder size={16} /> Use folder {state?.mode === "folder" ? <Check size={14} className="ml-auto" /> : null}
              </button>
              {(state?.candidates ?? []).map((candidate) => (
                <button
                  key={candidate.path}
                  disabled={busy || !api}
                  aria-label={`Use ${candidate.path}`}
                  onClick={() => void perform(() => api.choose(rootPath, { mode: "manual", path: candidate.path }))}
                  className={cn(menuItem, "min-w-0")}
                >
                  <IconImage source={candidate.dataUrl} />
                  <span className="truncate" data-tip={candidate.path}>
                    {candidate.path}
                  </span>
                  {state?.selected?.path === candidate.path ? <Check size={14} className="ml-auto shrink-0" /> : null}
                </button>
              ))}
            </div>
            <DiscoveryStatus loading={icons.isFetching} state={state} />
            {error || icons.isError ? (
              <p role="alert" className="px-2.5 pt-2 text-sm text-bad">
                {error ?? "Could not read project icons. Try refreshing."}
              </p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-1 border-t border-line px-1 pt-1.5">
              <Button variant="ghost" size="sm" disabled={busy || !api} onClick={() => void perform(() => api.pick(rootPath))}>
                Choose file…
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || !api} onClick={() => void perform(() => api.refresh(rootPath), false)}>
                Refresh
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || !api || state?.mode === "auto"} onClick={() => void perform(() => api.choose(rootPath, { mode: "auto" }))}>
                Automatic
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A project's icon, and the popover that chooses it. A plain folder opens while its project's threads show. */
export function ProjectIconPicker({ rootPath, name, expanded }: { rootPath: string; name: string; expanded?: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: state } = useProjectIcon(rootPath);
  const fallback = state?.mode === "auto" ? state.fallback : null;
  const detected = state?.fallback ? PROJECT_STACK_LABELS[state.fallback] : null;
  return (
    <ProjectIconChooser rootPath={rootPath} open={open} onOpenChange={setOpen}>
      <Tooltip label={`Choose icon for ${name}${fallback && !state?.selected ? ` · ${detected}` : ""}`}>
        <Popover.Trigger
          disabled={!window.openorc?.projectIcons}
          aria-label={`Choose icon for ${name}`}
          className="project-icon-trigger no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-surface-2"
        >
          <IconImage source={state?.selected?.dataUrl} fallback={fallback} expanded={expanded} />
        </Popover.Trigger>
      </Tooltip>
    </ProjectIconChooser>
  );
}

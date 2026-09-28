import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectIconState } from "../../../shared/project-icons";
import { PROJECT_STACK_LABELS, type ProjectStackIconId } from "../../../shared/project-stack-icons";
import { projectIconKey, useProjectIcon } from "../lib/project-icons";
import { CoversPreview } from "../lib/browser-preview";
import { Folder, Check } from "./icons";
import { Button, Tooltip } from "./ui";
import { ProjectStackIcon } from "./ProjectStackIcon";

function IconImage({ source, fallback }: { source: string | undefined; fallback?: ProjectStackIconId | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!source || failed === source) return fallback ? <ProjectStackIcon id={fallback} className="shrink-0 text-ink-3" /> : <Folder size={16} className="shrink-0 text-ink-3" />;
  return <img src={source} alt="" width={16} height={16} className="size-4 shrink-0 object-contain" onError={() => setFailed(source)} />;
}

function DiscoveryStatus({ loading, state }: { loading: boolean; state: ProjectIconState | undefined }) {
  if (loading)
    return (
      <p role="status" className="text-sm text-ink-3 mt-2">
        Looking for icons…
      </p>
    );
  if (state?.fallback) return <p className="text-sm text-ink-3 mt-2">Detected {PROJECT_STACK_LABELS[state.fallback]}. Automatic uses its icon when no repository image is selected.</p>;
  if (state?.candidates.length === 0) return <p className="text-sm text-ink-3 mt-2">No suitable icons found in this repository.</p>;
  return null;
}

export function ProjectIconPicker({ rootPath, name }: { rootPath: string; name: string }) {
  const icons = useProjectIcon(rootPath);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = window.openorc?.projectIcons;
  const state = icons.data;
  const fallback = state?.mode === "auto" ? state.fallback : null;
  const detected = state?.fallback ? PROJECT_STACK_LABELS[state.fallback] : null;
  const busy = pending || icons.isFetching;
  const perform = async (action: () => Promise<ProjectIconState | null>, close = true) => {
    setPending(true);
    setError(null);
    try {
      const next = await action();
      if (next) {
        client.setQueryData(projectIconKey(rootPath), next);
        if (close) setOpen(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the project icon.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={`Choose icon for ${name}${fallback && !state?.selected ? ` · ${detected}` : ""}`}>
        <Popover.Trigger disabled={!api} aria-label={`Choose icon for ${name}`} className="no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-surface-2">
          <IconImage source={state?.selected?.dataUrl} fallback={fallback} />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="right" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-3 shadow-panel">
            <Popover.Title className="text-md font-medium mb-3">Project icon</Popover.Title>
            <div className="flex flex-col gap-1">
              <button
                disabled={busy}
                onClick={() => void perform(() => api.choose(rootPath, { mode: "folder" }))}
                className="flex items-center gap-2 rounded-md px-2 py-2 text-base text-ink-2 hover:bg-surface-2"
              >
                <Folder size={16} /> Use folder {state?.mode === "folder" ? <Check size={14} className="ml-auto" /> : null}
              </button>
              {(state?.candidates ?? []).map((candidate) => (
                <button
                  key={candidate.path}
                  disabled={busy}
                  aria-label={`Use ${candidate.path}`}
                  onClick={() => void perform(() => api.choose(rootPath, { mode: "manual", path: candidate.path }))}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-base text-ink-2 hover:bg-surface-2"
                >
                  <IconImage source={candidate.dataUrl} />
                  <span className="truncate" title={candidate.path}>
                    {candidate.path}
                  </span>
                  {state?.selected?.path === candidate.path ? <Check size={14} className="ml-auto shrink-0" /> : null}
                </button>
              ))}
            </div>
            <DiscoveryStatus loading={icons.isFetching} state={state} />
            {error || icons.isError ? (
              <p role="alert" className="text-sm text-bad mt-2">
                {error ?? "Could not read project icons. Try refreshing."}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1 border-t border-line pt-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(() => api.pick(rootPath))}>
                Choose file…
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(() => api.refresh(rootPath), false)}>
                Refresh
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || state?.mode === "auto"} onClick={() => void perform(() => api.choose(rootPath, { mode: "auto" }))}>
                Automatic
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

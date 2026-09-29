import { useEffect, useState } from "react";
import type { UpdateSnapshot, UpdateState } from "../../../shared/app-updates";
import { CoversPreview } from "../lib/browser-preview";
import { Download } from "./icons";
import { TextButton } from "./ui";

function useAppUpdate() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  useEffect(() => {
    const api = window.openorc?.updates;
    // A renderer hot reload can precede the new preload in development.
    if (!api?.onState) return;
    let active = true;
    let received = false;
    const off = api.onState((next) => {
      received = true;
      if (active) setSnapshot(next);
    });
    void api
      .getState()
      .then((initial) => {
        if (active && !received) setSnapshot(initial);
      })
      .catch(() => {
        /* The native menu remains available if the window channel is unavailable. */
      });
    return () => {
      active = false;
      off();
    };
  }, []);
  return snapshot;
}

function noticeText(state: UpdateState): { title: string; detail: string } | null {
  switch (state.phase) {
    case "available":
      return { title: `OpenOrc ${state.version} is available`, detail: "Download the update while you keep working." };
    case "downloading":
      return { title: "Downloading OpenOrc update", detail: "You can keep working. We’ll let you know when it’s ready." };
    case "ready":
      return { title: "OpenOrc is ready to update", detail: `Restart to install version ${state.version}. Your conversations will be kept.` };
    case "installing":
      return { title: "Preparing to restart", detail: "Checking that your work has finished before installing." };
    case "install-error":
      return { title: "OpenOrc could not restart to update", detail: `${state.message} When your work has finished, quit and reopen OpenOrc before trying again.` };
    default:
      return null;
  }
}

export function AppUpdateNotice() {
  const snapshot = useAppUpdate();
  return snapshot ? <AppUpdateNoticeContent snapshot={snapshot} /> : null;
}

function actionLabel(state: UpdateState): string {
  if (state.phase === "ready") return "Restart to update";
  if (state.phase === "available" && state.error) return "Retry download";
  return "Download update";
}

/** Shared by the running app and the visual fixture; all actions go to the existing main-process updater. */
export function AppUpdateNoticeContent({ snapshot }: { snapshot: UpdateSnapshot }) {
  const { state, dismissed } = snapshot;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = noticeText(state);
  if (!text || dismissed) return null;
  const run = async (action: "download" | "install" | "dismiss") => {
    setPending(true);
    setError(null);
    try {
      await window.openorc.updates[action]();
    } catch {
      setError("Could not complete that action. Try again or use the update menu.");
    } finally {
      setPending(false);
    }
  };
  const problem = ("error" in state && state.error) || error;
  const actionable = state.phase === "available" || state.phase === "ready";
  const hideable = state.phase === "downloading" || state.phase === "install-error";
  const percent = state.phase === "downloading" ? Math.round(state.percent ?? 0) : null;
  return (
    <aside className="agent-update-notice" aria-label="OpenOrc update">
      <CoversPreview />
      <Download size={18} className="shrink-0 text-ink-2 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div role="status" aria-live="polite">
          <p className="font-medium break-words">{text.title}</p>
          <p className="text-sm text-ink-2 mt-1">{text.detail}</p>
        </div>
        {percent !== null ? (
          <div className="mt-3">
            <progress className="app-update-progress" aria-label="Update download progress" value={percent} max={100} />
            <p className="text-sm text-ink-2 tabular-nums mt-1">{percent}% downloaded</p>
          </div>
        ) : null}
        {problem ? (
          <p role="alert" className="text-sm text-bad mt-2 break-words">
            {problem}
          </p>
        ) : null}
        {actionable ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3">
            <TextButton disabled={pending} className="text-sm" onClick={() => void run(state.phase === "ready" ? "install" : "download")}>
              {actionLabel(state)}
            </TextButton>
            <TextButton disabled={pending} className="text-sm text-ink-2" onClick={() => void run("dismiss")}>
              Later
            </TextButton>
          </div>
        ) : null}
        {hideable ? (
          <TextButton className="text-sm text-ink-2 mt-3" onClick={() => void run("dismiss")}>
            Hide
          </TextButton>
        ) : null}
      </div>
    </aside>
  );
}

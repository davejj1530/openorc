import { useState } from "react";
import type { UpdateState } from "../../../shared/app-updates";
import { useAppUpdate } from "./AppUpdateNotice";
import { Download } from "./icons";
import { Tooltip } from "./ui";

type UpdateAct = "download" | "install";

/**
 * What the footer's update button says while an update waits, and what pressing it does then. Checking stays in the
 * app menu, so with nothing newer known there is no button.
 */
function updateStep(state: UpdateState): { label: string; act?: UpdateAct; percent?: number } | null {
  switch (state.phase) {
    case "available":
      return { label: state.error ? `Retry downloading OpenOrc ${state.version}` : `Download OpenOrc ${state.version}`, act: "download" };
    case "downloading":
      return { label: `Downloading OpenOrc ${state.version} · ${Math.round(state.percent ?? 0)}%`, percent: state.percent ?? 0 };
    case "ready":
      return { label: `Restart to update to OpenOrc ${state.version}`, act: "install" };
    case "installing":
      return { label: "Preparing to restart…" };
    case "install-error":
      return { label: `OpenOrc couldn’t restart to update: ${state.message} Quit and reopen OpenOrc, then try again.`, act: "install" };
    default:
      return null;
  }
}

/**
 * OpenOrc's own update, beside Settings once one waits: download it, watch it come down, then restart into it. It stays
 * after the update notice is put off, so the way to update is always here.
 */
export function SidebarUpdate() {
  const snapshot = useAppUpdate();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const step = snapshot ? updateStep(snapshot.state) : null;
  if (!step) return null;
  const run = async (act: UpdateAct) => {
    setPending(true);
    setFailed(null);
    await window.openorc.updates[act]().catch((error: unknown) => setFailed(`${error instanceof Error ? error.message : "The update didn’t start."} Try again.`));
    setPending(false);
  };
  const label = failed ?? step.label;
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        aria-disabled={!step.act || pending || undefined}
        data-offer={step.act ? true : undefined}
        className="sidebar-tool sidebar-update no-drag"
        onClick={() => {
          if (step.act && !pending) void run(step.act);
        }}
      >
        {step.percent !== undefined ? (
          <svg viewBox="0 0 28 28" className="sidebar-update-ring" aria-hidden="true">
            <circle cx="14" cy="14" r="12" pathLength="100" className="sidebar-update-track" />
            <circle cx="14" cy="14" r="12" pathLength="100" strokeDasharray={`${Math.min(100, step.percent)} 100`} transform="rotate(-90 14 14)" className="sidebar-update-fill" />
          </svg>
        ) : null}
        <Download size={16} />
        {step.act ? <span aria-hidden="true" className="sidebar-update-dot" /> : null}
      </button>
    </Tooltip>
  );
}

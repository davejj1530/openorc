import { useState } from "react";
import type { UpdateState } from "../../../shared/app-updates";
import { useAppUpdate } from "./AppUpdateNotice";
import { Download } from "./icons";
import { RAIL_ICON } from "./sidebar-screens";
import { Tooltip } from "./ui";

/** What the rail's update button says in each phase with something to offer, and what pressing it does then. */
function updateStep(state: UpdateState): { label: string; act?: "download" | "install"; percent?: number } | null {
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
 * OpenOrc's own update, above Settings while there is one: download it, watch it come down, then restart into it. It
 * stays after the update notice is put off, so the way to update is always here; with nothing new it is not shown.
 */
export function RailUpdate() {
  const snapshot = useAppUpdate();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const step = snapshot ? updateStep(snapshot.state) : null;
  if (!step) return null;
  const run = async (act: "download" | "install") => {
    setPending(true);
    setFailed(null);
    await window.openorc.updates[act]().catch((error: unknown) => setFailed(`${error instanceof Error ? error.message : "The update didn’t start."} Try again.`));
    setPending(false);
  };
  const label = failed ?? step.label;
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-disabled={!step.act || pending || undefined}
        className="sidebar-dock-button sidebar-rail-update no-drag"
        onClick={() => {
          if (step.act && !pending) void run(step.act);
        }}
      >
        {step.percent !== undefined ? (
          <svg viewBox="0 0 36 36" className="sidebar-rail-update-ring" aria-hidden="true">
            <circle cx="18" cy="18" r="16" pathLength="100" className="sidebar-rail-update-track" />
            <circle cx="18" cy="18" r="16" pathLength="100" strokeDasharray={`${Math.min(100, step.percent)} 100`} transform="rotate(-90 18 18)" className="sidebar-rail-update-fill" />
          </svg>
        ) : null}
        <Download size={RAIL_ICON} />
        {step.act ? <span aria-hidden="true" className="sidebar-rail-update-dot" /> : null}
      </button>
    </Tooltip>
  );
}

import { useState } from "react";
import type { UpdateState } from "../../../shared/app-updates";
import { useAppUpdate } from "./AppUpdateNotice";
import { Download, Loader2 } from "./icons";
import { RAIL_ICON } from "./sidebar-screens";
import { Tooltip } from "./ui";

type UpdateAct = "check" | "download" | "install";

/** What the rail's update button says in each phase and what pressing it does then: a check while nothing newer is known. */
function updateStep(state: UpdateState): { label: string; act?: UpdateAct; percent?: number; busy?: boolean } | null {
  switch (state.phase) {
    case "idle":
      return { label: "Check for updates", act: "check" };
    case "checking":
      return { label: "Checking for updates…", busy: true };
    case "current":
      return { label: "OpenOrc is up to date. Check again", act: "check" };
    case "error":
      return { label: `Couldn’t check for updates: ${state.message} Check again`, act: "check" };
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
 * OpenOrc's own updates, above Settings: check for one, download it, watch it come down, then restart into it. It
 * stays after the update notice is put off, so the way to update is always here. A build that can't update hides it.
 */
export function RailUpdate() {
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
  const offer = step.act === "download" || step.act === "install";
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-disabled={!step.act || pending || undefined}
        data-offer={offer || undefined}
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
        {step.busy ? <Loader2 size={RAIL_ICON} className="sidebar-rail-update-spin" /> : <Download size={RAIL_ICON} />}
        {offer ? <span aria-hidden="true" className="sidebar-rail-update-dot" /> : null}
      </button>
    </Tooltip>
  );
}

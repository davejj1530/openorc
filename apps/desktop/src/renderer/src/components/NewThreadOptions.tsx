import { Fragment, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import { cloudTime, type NewThreadPlace, type StartBlock, type StartFix } from "@openorc/client";
import { WORKSPACE_ID, type CloudHours } from "@openorc/protocol";
import type { ComposerProps } from "./Composer";
import { Check, Cloud, Folder, GitBranch } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import type { NewThreadCloud, NewThreadHosted } from "../lib/cloud-offered";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";

/** The wait before a blocked row says why, under the pointer or keyboard focus. */
const WHY_DELAY_MS = 400;

interface Place {
  value: NewThreadPlace;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** A cloud's row: the menu draws one hairline between this Mac's places and the clouds. */
  cloud: boolean;
  blocked: StartBlock | null;
  /** One quiet fact that matters when choosing, at the end of a row that can be picked. */
  fact?: ReactNode;
}

const ICONS: Record<NewThreadPlace, ComponentType<{ size?: number }>> = { current: GitBranch, worktree: Folder, cloud: Cloud, hosted: Cloud };

/** The hours left on OpenOrc Cloud: a filled share of the month's, when there is one, and the time. */
function HoursLeft({ hours }: { hours: CloudHours }) {
  const share = hours.monthly ? Math.min(1, hours.leftSeconds / hours.monthly.grantedSeconds) : null;
  const angle = (share ?? 0) * 2 * Math.PI;
  const end = { x: 8 + 6.5 * Math.sin(angle), y: 8 - 6.5 * Math.cos(angle) };
  return (
    <span className="new-thread-place-hours">
      {share !== null ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="currentColor" fillOpacity="0.2" />
          {share >= 1 ? <circle cx="8" cy="8" r="6.5" fill="currentColor" /> : null}
          {share > 0 && share < 1 ? <path d={`M8 8V1.5A6.5 6.5 0 ${share > 0.5 ? 1 : 0} 1 ${end.x} ${end.y}Z`} fill="currentColor" /> : null}
        </svg>
      ) : null}
      {cloudTime(hours.leftSeconds)}
    </span>
  );
}

/** Every place, from this folder outward: the checkout, a worktree beside it, the person's own cloud, then OpenOrc's. */
function places(cloud: NewThreadCloud, hosted: NewThreadHosted, local: boolean): Place[] {
  const all: (Place & { shown: boolean })[] = [
    { value: "current", label: "Local checkout", icon: ICONS.current, cloud: false, blocked: null, shown: true },
    { value: "worktree", label: "Worktree", icon: ICONS.worktree, cloud: false, blocked: null, shown: true },
    { value: "cloud", label: "Your own cloud", icon: ICONS.cloud, cloud: true, blocked: cloud.blocked, shown: cloud.shown, fact: cloud.service },
    {
      value: "hosted",
      label: "OpenOrc Cloud",
      icon: ICONS.hosted,
      cloud: true,
      blocked: hosted.blocked ?? (!local && !hosted.shown ? { words: "Checking OpenOrc Cloud…", fix: null, reason: "Checking" } : null),
      shown: hosted.shown || !local,
      fact: hosted.hours ? <HoursLeft hours={hosted.hours} /> : null,
    },
  ];
  return all.filter((place) => place.shown && (local || place.value === "hosted"));
}

function takeFix(fix: StartFix) {
  useRouter.getState().navigate({ view: "settings", section: fix.section, ...(fix.project ? { project: fix.project } : {}) });
}

/** Where the thread will work, said as a sentence with one verb for every place. */
function placeWords(mode: NewThreadPlace, branch: string | null): string {
  const words: Record<NewThreadPlace, string> = {
    current: `Works in the local checkout${branch ? ` on ${branch}` : ""}`,
    worktree: `Works in a new worktree${branch ? ` off ${branch}` : ""}`,
    cloud: `Works in your own cloud, on a new branch${branch ? ` from ${branch}` : ""}`,
    hosted: `Works on OpenOrc Cloud, on a new branch${branch ? ` from ${branch}` : ""}`,
  };
  return words[mode];
}

/**
 * The menu of places a new thread can work in. A blocked place stays a row: dimmed, ending in the way to its fix, which a
 * press takes, or in a few words of why where nothing here fixes it. The sentence that says why comes on demand, under
 * the pointer or keyboard focus.
 */
function PlaceMenu(props: {
  local: boolean;
  mode: NewThreadPlace;
  branch: string | null;
  cloud: NewThreadCloud;
  hosted: NewThreadHosted;
  disabled: boolean;
  disabledReason: string | null;
  onMode: (mode: NewThreadPlace) => void;
}) {
  const rows = places(props.cloud, props.hosted, props.local);
  const current = rows.find((row) => row.value === props.mode) ?? rows[0]!;
  const Icon = ICONS[props.mode];
  const [why, setWhy] = useState<{ anchor: HTMLElement; words: string } | null>(null);
  const wait = useRef(0);
  useEffect(() => () => window.clearTimeout(wait.current), []);
  const focus = (anchor: HTMLElement, block: StartBlock | null) => {
    window.clearTimeout(wait.current);
    setWhy(null);
    if (block?.fix) wait.current = window.setTimeout(() => setWhy({ anchor, words: block.words }), WHY_DELAY_MS);
  };
  const blur = () => {
    window.clearTimeout(wait.current);
    setWhy(null);
  };
  return (
    <Menu.Root onOpenChange={(open) => (open ? undefined : blur())}>
      <Menu.Trigger
        disabled={props.disabled || Boolean(props.disabledReason)}
        aria-label={`Where the thread works: ${current.label}`}
        data-tip={props.disabledReason ?? placeWords(props.mode, props.branch)}
        className="composer-icon-button"
      >
        <Icon size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "new-thread-places")}>
            {rows.map((row, index) => (
              <Fragment key={row.value}>
                {index > 0 && row.cloud && !rows[index - 1]?.cloud ? <Menu.Separator className={menuSeparator} /> : null}
                <Menu.Item
                  className={cn(menuItem, "new-thread-place")}
                  data-current={row.value === props.mode || undefined}
                  data-blocked={row.blocked ? "" : undefined}
                  aria-description={row.blocked?.words}
                  disabled={Boolean(row.blocked && !row.blocked.fix)}
                  onFocus={(event) => focus(event.currentTarget, row.blocked)}
                  onBlur={blur}
                  onClick={() => (row.blocked?.fix ? takeFix(row.blocked.fix) : props.onMode(row.value))}
                >
                  <row.icon size={15} />
                  <span className="new-thread-place-label">{row.label}</span>
                  <span className="new-thread-place-end">
                    {row.blocked ? (
                      <span className={cn(row.blocked.fix ? "text-ink" : "text-ink-3")}>{row.blocked.fix?.label ?? row.blocked.reason}</span>
                    ) : (
                      <>
                        {row.fact ? <span className="new-thread-place-fact">{row.fact}</span> : null}
                        {row.value === props.mode ? <Check size={14} className="text-ink" /> : null}
                      </>
                    )}
                  </span>
                </Menu.Item>
              </Fragment>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
      <Tooltip.Root open={why !== null}>
        <Tooltip.Portal>
          <CoversPreview />
          <Tooltip.Positioner anchor={why?.anchor ?? null} side="bottom" align="end" sideOffset={6}>
            <Tooltip.Popup ref={floatingGround} className="tooltip-popup tooltip-popup-tip">
              {why?.words}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Menu.Root>
  );
}

/** In the New thread composer's bar: where the thread works, as one icon that opens the places, or the Workspace folder's chooser. */
export function NewThreadOptions(props: {
  local?: boolean;
  projectId: string;
  mode: NewThreadPlace;
  cloud: NewThreadCloud;
  hosted: NewThreadHosted;
  location: ComposerProps["location"];
  blocked: string | null;
  disabled: boolean;
  onFolder: (folder: string) => void;
  onMode: (mode: NewThreadPlace) => void;
}) {
  const chooseFolder = async () => {
    const folder = await window.openorc.pickDirectory();
    if (folder) props.onFolder(folder);
  };
  if (props.projectId === WORKSPACE_ID)
    return (
      <button
        type="button"
        className="composer-icon-button"
        aria-label="Choose the folder for this conversation"
        data-tip={`Works in ${props.location.directory}`}
        disabled={props.disabled}
        onClick={() => void chooseFolder()}
      >
        <Folder size={16} />
      </button>
    );
  return (
    <PlaceMenu
      local={props.local ?? true}
      mode={props.mode}
      branch={props.location.branch}
      cloud={props.cloud}
      hosted={props.hosted}
      disabled={props.disabled}
      disabledReason={props.local === false ? null : props.blocked}
      onMode={props.onMode}
    />
  );
}

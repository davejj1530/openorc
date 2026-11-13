import { Fragment, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import { cloudTime, type NewThreadPlace, type StartBlock, type StartFix } from "@openorc/client";
import { WORKSPACE_ID, type CloudHours } from "@openorc/protocol";
import type { ComposerProps } from "./Composer";
import { Check, ChevronDown, Cloud, Folder, GitBranch } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { Button } from "./ui";
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
function places(cloud: NewThreadCloud, hosted: NewThreadHosted): Place[] {
  const all: (Place & { shown: boolean })[] = [
    { value: "current", label: "Local checkout", icon: ICONS.current, cloud: false, blocked: null, shown: true },
    { value: "worktree", label: "Worktree", icon: ICONS.worktree, cloud: false, blocked: null, shown: true },
    { value: "cloud", label: "Your own cloud", icon: ICONS.cloud, cloud: true, blocked: cloud.blocked, shown: cloud.shown, fact: cloud.service },
    { value: "hosted", label: "OpenOrc Cloud", icon: ICONS.hosted, cloud: true, blocked: hosted.blocked, shown: hosted.shown, fact: hosted.hours ? <HoursLeft hours={hosted.hours} /> : null },
  ];
  return all.filter((place) => place.shown);
}

function takeFix(fix: StartFix) {
  useRouter.getState().navigate({ view: "settings", section: fix.section, ...(fix.project ? { project: fix.project } : {}) });
}

/** Where the thread will work, said as a sentence with one verb for every place. */
function LocationSentence({ mode, branch }: { mode: NewThreadPlace; branch: string | null }) {
  const name = branch ? <span className="composer-branch">{branch}</span> : null;
  const words: Record<NewThreadPlace, ReactNode> = {
    current: <>Works in the local checkout{name ? <> on {name}</> : null}</>,
    worktree: <>Works in a new worktree{name ? <> off {name}</> : null}</>,
    cloud: <>Works in your own cloud, on a new branch{name ? <> from {name}</> : null}</>,
    hosted: <>Works on OpenOrc Cloud, on a new branch{name ? <> from {name}</> : null}</>,
  };
  return <span className="new-thread-sentence">{words[mode]}</span>;
}

/**
 * The menu of places a new thread can work in. A blocked place stays a row: dimmed, ending in the way to its fix, which a
 * press takes, or in a few words of why where nothing here fixes it. The sentence that says why comes on demand, under
 * the pointer or keyboard focus.
 */
function PlaceMenu(props: {
  mode: NewThreadPlace;
  branch: string | null;
  cloud: NewThreadCloud;
  hosted: NewThreadHosted;
  disabled: boolean;
  disabledReason: string | null;
  onMode: (mode: NewThreadPlace) => void;
}) {
  const rows = places(props.cloud, props.hosted);
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
        data-tip={props.disabledReason ?? undefined}
        className="composer-text-choice"
      >
        <Icon size={14} />
        <LocationSentence mode={props.mode} branch={props.branch} />
        <ChevronDown size={12} className="composer-chip-chevron" />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "new-thread-places")}>
            {rows.map((row, index) => (
              <Fragment key={row.value}>
                {row.cloud && !rows[index - 1]?.cloud ? <Menu.Separator className={menuSeparator} /> : null}
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

/** Under the New thread composer: where the thread works, a menu or the Workspace folder. The Claude account is in the model picker. */
export function NewThreadOptions(props: {
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
  return (
    <div className="new-thread-options" role="group" aria-label="New thread context">
      <div className="new-thread-location">
        {props.projectId === WORKSPACE_ID ? (
          <>
            <span className="new-thread-folder" data-tip={props.location.directory}>
              <Folder size={14} />
              <span>{props.location.directory}</span>
            </span>
            <Button variant="ghost" size="sm" disabled={props.disabled} data-tip="Choose the folder for this conversation" onClick={() => void chooseFolder()}>
              Choose folder
            </Button>
          </>
        ) : (
          <PlaceMenu mode={props.mode} branch={props.location.branch} cloud={props.cloud} hosted={props.hosted} disabled={props.disabled} disabledReason={props.blocked} onMode={props.onMode} />
        )}
      </div>
    </div>
  );
}

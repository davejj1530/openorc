import { useContext, type ReactNode } from "react";
import { MessageSquare, Orclings, Plus, Search, Settings } from "./icons";
import { Tooltip } from "./ui";
import { ProjectPicker } from "./ProjectPicker";
import { newThread, useRouter, type Route } from "../lib/router";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useUi } from "../lib/ui";
import { OpenOrcMark } from "./OpenOrcMark";
import { OrclingsRailContext, type OrclingsRailDestination } from "../lib/orclings-rail";
import { SidebarNav } from "./SidebarNav";

function RailButton({ icon, label, active, count, onClick }: { icon: ReactNode; label: string; active?: boolean; count?: number; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button className="workspace-rail-button" aria-label={count ? `${label}, ${count}` : label} aria-current={active ? "page" : undefined} onClick={onClick}>
        {icon}
        {count ? (
          <span className="workspace-rail-count" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}

/** App destinations share a slim rail and one space for their navigation list. */
export function WorkspaceRail({
  route,
  projectId,
  orclings: nativeOrclings,
  onProject,
  onThreads,
}: {
  route: Route;
  projectId: string | null;
  orclings?: OrclingsRailDestination;
  onProject: (id: string | null) => void;
  onThreads: () => void;
}) {
  const openPage = useRouter((state) => state.navigate);
  const orclings = useContext(OrclingsRailContext) ?? nativeOrclings;
  const navigate = (destination: Route) => {
    openPage(destination);
    dismissCompactNavigation();
  };
  return (
    <div className="workspace-rail">
      <div className="rail-window-space drag-region h-topbar" aria-hidden="true" />
      <div className="workspace-rail-brand" role="img" aria-label="OpenOrc">
        <OpenOrcMark />
      </div>
      <nav className="workspace-rail-nav" aria-label="Workspace">
        <RailButton icon={<Search size={19} />} label="Search" onClick={() => useUi.getState().setPalette(true)} />
        <RailButton icon={<MessageSquare size={19} />} label="Threads" active={!orclings?.active && (route.view === "thread" || route.view === "newthread")} onClick={onThreads} />
        {orclings ? <RailButton icon={<Orclings size={19} />} label="Orclings" active={orclings.active} onClick={orclings.open} /> : null}
        <div className="workspace-rail-divider" />
        <ProjectPicker projectId={projectId} onProject={onProject} compact />
        <SidebarNav route={route} projectId={projectId} rail />
      </nav>
      <div className="workspace-rail-footer">
        <RailButton
          icon={<Plus size={19} />}
          label="New thread"
          onClick={() => {
            newThread(projectId ?? undefined);
            dismissCompactNavigation();
          }}
        />
        <RailButton icon={<Settings size={19} />} label="Settings" active={route.view === "settings"} onClick={() => navigate({ view: "settings" })} />
      </div>
    </div>
  );
}

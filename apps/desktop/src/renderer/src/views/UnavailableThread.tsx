import { ThreadTabs } from "../components/ThreadTabs";
import { TopBar } from "../components/TopBar";
import { IconButton, Tooltip } from "../components/ui";
import { X } from "../components/icons";
import { useRpc } from "../lib/client";
import { useSpaceNavigation } from "../lib/space-navigation";
import { useRouter } from "../lib/router";
import { OrganizationNoProjects } from "./OrganizationNoProjects";

export function UnavailableThread({ title, first, last, onClose, checking = false }: { title: string; first: boolean; last: boolean; onClose?: () => void; checking?: boolean }) {
  const current = useSpaceNavigation((state) => state.current);
  const status = useRpc("spaces.status", {});
  const space = status.data?.state === "ready" ? status.data.spaces.find((space) => space.id === current) : null;
  return (
    <main className="workspace-main well flex-1 min-w-0 flex flex-col">
      <TopBar
        windowDragSurface
        tabs={first}
        inSplit={!first}
        rightmost={last}
        actions={
          onClose ? (
            <Tooltip label="Close pane">
              <IconButton aria-label="Close pane" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </Tooltip>
          ) : null
        }
      >
        {first ? <ThreadTabs /> : <span className="truncate text-sm">{title}</span>}
      </TopBar>
      {!checking && space?.kind === "organization" ? <OrganizationNoProjects organization={space} lost onPeople={() => useRouter.getState().navigate({ view: "people", spaceId: space.id })} /> : null}
    </main>
  );
}

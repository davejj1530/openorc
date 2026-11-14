import { useState } from "react";
import { OrganizationProjectsDialog } from "../dialogs/OrganizationProjectsDialog";
import { useRpc } from "../lib/client";
import { useSpaceNavigation } from "../lib/space-navigation";
import { useUi } from "../lib/ui";
import { FolderPlus } from "./icons";
import { IconButton, Tooltip } from "./ui";

export function OrganizationAddProject() {
  const current = useSpaceNavigation((state) => state.current);
  const personal = useSpaceNavigation((state) => !state.current || state.current === state.personal);
  const status = useRpc("spaces.status", {}, { enabled: !personal });
  const space = status.data?.state === "ready" ? status.data.spaces.find((space) => space.id === current) : null;
  const [opened, setOpened] = useState<string | null>(null);
  const allowed = personal || (space?.kind === "organization" && space.role === "admin");
  return (
    <>
      {allowed ? (
        <Tooltip label="Add project">
          <IconButton size="xs" aria-label="Add project" className="no-drag" onClick={() => (personal ? useUi.getState().setImportProject(true) : setOpened(current))}>
            <FolderPlus size={16} />
          </IconButton>
        </Tooltip>
      ) : null}
      {opened ? (
        <OrganizationProjectsDialog
          open
          spaceId={opened}
          onOpenChange={(open) => {
            if (!open) setOpened(null);
          }}
          onAdded={() => {
            void status.refetch();
          }}
        />
      ) : null}
    </>
  );
}

import { Command } from "cmdk";
import { useOrganization } from "../lib/organization-context";
import { spaceName } from "../lib/space-name";
import { People, PersonPlus, Plus, FolderPlus } from "./icons";
import { OpenOrcMark } from "./OpenOrcMark";
import { OrganizationMark } from "./OrganizationMark";

export function OrganizationPalette({ go }: { go(action: () => void): void }) {
  const actions = useOrganization();
  if (!actions?.signedIn) return null;
  const data = actions.status?.state === "ready" ? actions.status : null;
  return (
    <>
      {actions.organization ? (
        <Command.Item className="command-palette-item" onSelect={() => go(() => actions.people())}>
          <People size={18} />
          <span>People</span>
        </Command.Item>
      ) : null}
      {actions.organization?.role === "admin" ? (
        <Command.Item className="command-palette-item" onSelect={() => go(actions.invite)}>
          <PersonPlus size={18} />
          <span>Invite people</span>
        </Command.Item>
      ) : null}
      {actions.organization?.role === "admin" ? (
        <Command.Item className="command-palette-item" onSelect={() => go(actions.addProjects)}>
          <FolderPlus size={18} />
          <span>Add project</span>
        </Command.Item>
      ) : null}
      {data?.create.allowed ? (
        <Command.Item className="command-palette-item" onSelect={() => go(actions.create)}>
          <Plus size={18} />
          <span>Create organization</span>
        </Command.Item>
      ) : null}
      {data?.spaces.map((space) => (
        <Command.Item key={space.id} className="command-palette-item" onSelect={() => go(() => actions.select(space.id))}>
          <span className="command-palette-icon">{space.kind === "personal" ? <OpenOrcMark size={18} /> : <OrganizationMark {...space} size={18} />}</span>
          <span className="command-palette-label">Switch to {spaceName(space)}</span>
        </Command.Item>
      ))}
    </>
  );
}

import { Command } from "cmdk";
import { useOrganization } from "../lib/organization-context";
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
          <People size={15} />
          <span>People</span>
        </Command.Item>
      ) : null}
      {actions.organization?.role === "admin" ? (
        <Command.Item className="command-palette-item" onSelect={() => go(actions.invite)}>
          <PersonPlus size={15} />
          <span>Invite people</span>
        </Command.Item>
      ) : null}
      {actions.organization?.role === "admin" ? (
        <Command.Item className="command-palette-item" onSelect={() => go(actions.addProjects)}>
          <FolderPlus size={15} />
          <span>Add project</span>
        </Command.Item>
      ) : null}
      {data?.create.allowed ? (
        <Command.Item className="command-palette-item" onSelect={() => go(actions.create)}>
          <Plus size={15} />
          <span>Create organization</span>
        </Command.Item>
      ) : null}
      {data?.spaces.map((space) => (
        <Command.Item key={space.id} className="command-palette-item" onSelect={() => go(() => actions.select(space.id))}>
          <span className="command-palette-icon">{space.kind === "personal" ? <OpenOrcMark size={15} /> : <OrganizationMark {...space} size={15} />}</span>
          <span className="command-palette-label">Switch to {space.kind === "personal" ? "Personal" : space.name}</span>
        </Command.Item>
      ))}
    </>
  );
}

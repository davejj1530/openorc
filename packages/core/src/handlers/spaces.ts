import type { HostedSpaces } from "@openorc/hosted";
import type { SpacesRpcResults } from "@openorc/protocol";
import type { Handlers } from "./types.js";

export function createSpacesHandlers(spaces: HostedSpaces | null): Pick<Handlers, keyof SpacesRpcResults> {
  const service = (): HostedSpaces => {
    if (!spaces) throw new Error("OpenOrc accounts aren't available here.");
    return spaces;
  };
  return {
    "spaces.create": (input) => service().setup.create(input),
    "organization.update": (input) => service().setup.update(input),
    "organization.repositories": ({ spaceId }) => service().setup.repositories(spaceId),
    "organization.github.connect": ({ spaceId }) => service().setup.connect(spaceId),
    "organization.projects.add": (input) => service().setup.addProjects(input),
    "spaces.status": () => spaces?.status() ?? { state: "unavailable" },
    "spaces.projects": ({ spaceId }) => service().projects(spaceId),
    "organization.people": ({ spaceId, offset, limit }) => service().people(spaceId, offset, limit),
  };
}

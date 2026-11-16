import type { Hosted } from "@openorc/hosted";
import { projects, type Db } from "@openorc/db";
import type { HostedEnvironmentRpcResults } from "@openorc/protocol";
import { projectDotEnv } from "../services/project-dot-env.js";
import type { Handlers } from "./types.js";

/** A cloud project's own environment, read and set through the account; filled from this Mac's project folder. */
export function createHostedEnvironmentHandlers(account: Hosted | null, db: Db): Pick<Handlers, keyof HostedEnvironmentRpcResults> {
  const environment = () => {
    if (!account) throw new Error("OpenOrc accounts aren't available here.");
    return account.environment;
  };
  return {
    "hostedEnvironment.available": async ({ spaceId }) => (account ? account.environment.available(spaceId) : false),
    "hostedEnvironment.read": ({ spaceId, projectId }) => (account ? account.environment.read(spaceId, projectId) : { state: "unavailable" }),
    "hostedEnvironment.set": ({ spaceId, projectId, variables }) => environment().set(spaceId, projectId, variables),
    "hostedEnvironment.remove": ({ spaceId, projectId, name }) => environment().remove(spaceId, projectId, name),
    "hostedEnvironment.fromFile": ({ localProjectId }) => {
      const project = projects.get(db, localProjectId);
      if (!project) throw new Error("That project isn't on this Mac.");
      return projectDotEnv(project.rootPath);
    },
  };
}

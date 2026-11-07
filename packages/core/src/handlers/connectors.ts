import { threads, type Db } from "@openorc/db";
import type { FileScope } from "@openorc/protocol";
import { conversationFolder } from "../services/conversation-folder.js";
import { inUnvettedCopy } from "../services/review-copies.js";
import type { ConnectorService } from "../services/connectors.js";
import type { Handlers } from "./types.js";

type ConnectorMethod = "connectors.list" | "connectors.spec" | "connectors.save" | "connectors.remove" | "connectors.setOn" | "connectors.signIn" | "connectors.cancelSignIn" | "connectors.signOut";

/**
 * Where a conversation's connectors are read. Reading starts the servers a folder configures, so a copy of code the user
 * has not vetted, such as a pull request under review, is read from the home folder: its own servers never run there either.
 */
async function trustedFolder(db: Db, scope: FileScope | undefined): Promise<string | undefined> {
  if (!scope) return undefined;
  const thread = scope.kind === "thread" ? threads.get(db, scope.id) : null;
  if (thread && inUnvettedCopy(db, thread)) return undefined;
  return (await conversationFolder(db, scope)).root;
}

export function createConnectorHandlers({ db, connectors }: { db: Db; connectors: ConnectorService }): Pick<Handlers, ConnectorMethod> {
  return {
    "connectors.list": async ({ scope, refresh }) => connectors.list(await trustedFolder(db, scope), refresh),
    "connectors.spec": ({ agent, name }) => connectors.spec(agent, name),
    "connectors.save": (input) => connectors.save(input),
    "connectors.remove": ({ name }) => connectors.remove(name),
    "connectors.setOn": async ({ agent, name, on }) => {
      await connectors.setOn(agent, name, on);
      return { ok: true };
    },
    "connectors.signIn": ({ name }) => connectors.signInEverywhere(name),
    "connectors.cancelSignIn": () => {
      connectors.cancelSignIn();
      return { ok: true };
    },
    "connectors.signOut": ({ name }) => connectors.signOut(name),
  };
}

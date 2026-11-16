import type { Hosted } from "@openorc/hosted";
import type { HostedConnectorsRpcResults } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** A person's own cloud connectors, read and saved through the account. A Mac connector's headers are read with `connectors.spec`. */
export function createHostedConnectorsHandlers(account: Hosted | null): Pick<Handlers, keyof HostedConnectorsRpcResults> {
  const connectors = () => {
    if (!account) throw new Error("OpenOrc accounts aren't available here.");
    return account.connectors;
  };
  return {
    "hostedConnectors.read": () => (account ? account.connectors.read() : { state: "unavailable" }),
    "hostedConnectors.save": (input) => connectors().save(input),
    "hostedConnectors.remove": ({ name }) => connectors().remove(name),
  };
}

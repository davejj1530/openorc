import type { Hosted } from "@openorc/hosted";
import type { HostedMachinesRpcResults } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** The person's machines awake now, read and stopped through the account. */
export function createHostedMachinesHandlers(account: Hosted | null): Pick<Handlers, keyof HostedMachinesRpcResults> {
  return {
    "cloudMachines.read": () => (account ? account.machines.read() : { state: "unavailable" }),
    "cloudMachines.stop": ({ id }) => {
      if (!account) throw new Error("OpenOrc accounts aren't available here.");
      return account.machines.stop(id);
    },
  };
}

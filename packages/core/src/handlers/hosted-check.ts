import type { Hosted } from "@openorc/hosted";
import type { HostedCheckRpcResults } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** The person's cloud check, read and started through the account. */
export function createHostedCheckHandlers(account: Hosted | null): Pick<Handlers, keyof HostedCheckRpcResults> {
  return {
    "cloudCheck.read": () => (account ? account.check.read() : { state: "unavailable" }),
    "cloudCheck.start": ({ spaceId }) => {
      if (!account) throw new Error("OpenOrc accounts aren't available here.");
      return account.check.start(spaceId);
    },
  };
}

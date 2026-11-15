import type { Hosted } from "@openorc/hosted";
import type { CloudRemoteRpcResults } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** Who is signed in on this Mac, for a phone that reads OpenOrc Cloud through it: a name and a picture, never the mail, the plan or the hours. */
export function createAccountPersonHandlers(account: () => Hosted | null): Pick<Handlers, keyof CloudRemoteRpcResults> {
  return {
    "account.person": () => {
      const status = account()?.account.status();
      return status?.state === "signed-in" ? { name: status.name, image: status.image } : null;
    },
  };
}

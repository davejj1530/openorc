import type { HostedAccount } from "@openorc/hosted";
import type { AccountStatus } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** What a core with no account server answers. */
const NO_ACCOUNT: AccountStatus = { state: "signed-out", codeSentTo: null, ended: false, error: null };
const UNAVAILABLE = "OpenOrc accounts aren't available here.";

/** Every call answers the whole status. The package tells the windows itself when the status changes later. */
export function createAccountHandlers(
  account: HostedAccount | null,
): Pick<
  Handlers,
  "account.status" | "account.sendCode" | "account.signIn" | "account.signOut" | "account.setSandbox" | "account.signIns.connect" | "account.signIns.cancel" | "account.signIns.remove"
> {
  const after = async (work: (account: HostedAccount) => Promise<void>): Promise<AccountStatus> => {
    if (!account) throw new Error(UNAVAILABLE);
    await work(account);
    return account.status();
  };
  return {
    "account.status": () => account?.status() ?? NO_ACCOUNT,
    "account.sendCode": ({ email }) => after((a) => a.sendCode(email)),
    "account.signIn": ({ email, code }) => after((a) => a.signIn(email, code)),
    "account.signOut": () => after((a) => a.signOut()),
    "account.setSandbox": ({ service }) => after((a) => a.setSandbox(service)),
    "account.signIns.connect": (input) => after((a) => a.connectSignIn(input)),
    "account.signIns.cancel": ({ agent }) => after(async (a) => a.cancelSignIn(agent)),
    "account.signIns.remove": (input) => after((a) => a.removeSignIn(input)),
  };
}

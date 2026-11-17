import type { HostedAccount } from "@openorc/hosted";
import type { AccountStatus } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** What a core with no account server answers. */
const NO_ACCOUNT: AccountStatus = { state: "unavailable" };
const UNAVAILABLE = "OpenOrc accounts aren't available here.";

/** Every call answers the whole status. The package tells the windows itself when the status changes later. */
export function createAccountHandlers(
  account: HostedAccount | null,
): Pick<
  Handlers,
  | "account.status"
  | "account.signIn"
  | "account.signIn.cancel"
  | "account.signOut"
  | "account.profile.update"
  | "account.setSandbox"
  | "account.signIns.connect"
  | "account.signIns.cancel"
  | "account.signIns.remove"
  | "account.github.connect"
  | "account.github.cancel"
  | "account.github.disconnect"
  | "account.billing.open"
  | "account.billing.leave"
  | "account.offers"
  | "account.deletion"
  | "account.deletion.code"
  | "account.delete"
> {
  const after = async (work: (account: HostedAccount) => Promise<void>): Promise<AccountStatus> => {
    if (!account) throw new Error(UNAVAILABLE);
    await work(account);
    return account.status();
  };
  return {
    "account.status": () => account?.status() ?? NO_ACCOUNT,
    "account.signIn": () => after((a) => a.signIn()),
    "account.signIn.cancel": () => after(async (a) => a.cancelSigningIn()),
    "account.signOut": () => after((a) => a.signOut()),
    "account.profile.update": (input) => after((a) => a.updateProfile(input)),
    "account.setSandbox": ({ service }) => after((a) => a.setSandbox(service)),
    "account.signIns.connect": (input) => after((a) => a.connectSignIn(input)),
    "account.signIns.cancel": ({ agent }) => after(async (a) => a.cancelSignIn(agent)),
    "account.signIns.remove": (input) => after((a) => a.removeSignIn(input)),
    "account.github.connect": (input) => after((a) => a.connectGithub(input)),
    "account.github.cancel": () => after(async (a) => a.cancelGithub()),
    "account.github.disconnect": () => after((a) => a.disconnectGithub()),
    "account.billing.open": (page) => after((a) => a.openBilling(page)),
    "account.billing.leave": () => after(async (a) => a.leaveBilling()),
    "account.offers": () => account?.offers() ?? null,
    "account.deletion": () => {
      if (!account) throw new Error(UNAVAILABLE);
      return account.deletion();
    },
    "account.deletion.code": () => after((a) => a.sendDeletionCode()),
    "account.delete": (input) => after((a) => a.deleteAccount(input)),
  };
}

import { organizationAccessAt } from "@openorc/client";
import type { AccountStatus } from "@openorc/protocol";
import { useEffect, useState } from "react";

type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

export function accountSeatState(account: SignedIn, now: number): SignedIn {
  const access = organizationAccessAt(account.organizationAccess, now);
  if (access === account.organizationAccess) return account;
  return { ...account, organizationAccess: access, plan: { pro: false }, hours: null, allowanceSource: null };
}

/** Repaint at the actual deadline, on focus, and at minute boundaries for local deadline words. */
export function useAccountSeatState(account: AccountStatus | undefined): { account: AccountStatus | undefined; now: number } {
  const [now, setNow] = useState(Date.now);
  const until = account?.state === "signed-in" && account.organizationAccess?.state === "grace" ? account.organizationAccess.until : null;
  useEffect(() => {
    if (until === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (current < until) timer = setTimeout(update, Math.min(until - current, 60000 - (current % 60000)));
    };
    update();
    window.addEventListener("focus", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", update);
    };
  }, [until]);
  return { account: account?.state === "signed-in" ? accountSeatState(account, Math.max(now, Date.now())) : account, now };
}

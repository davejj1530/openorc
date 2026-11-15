import { closedToPerson, spaceName, type PhoneSpaces } from "./use-spaces";

/*
 * What the phone says of the OpenOrc account it reads through a Mac, in its own words. The phone sells nothing, so
 * none of these names a price, a plan to buy or a place to pay.
 */

/** The line over Home's list when the space it shows cannot be read as usual; null while all is well. */
export function spaceNotice(account: PhoneSpaces, macName: string, now: number): string | null {
  if (account.state !== "ready") return null;
  if (closedToPerson(account.current, account.access, now)) return `Pro is needed for ${spaceName(account.current)}.`;
  if (account.offline) return `${macName} can't reach OpenOrc Cloud. This is what it last heard.`;
  return null;
}

/** The connection sheet's row for the account: who reads OpenOrc Cloud here and through which Mac, or that nobody is signed in there. */
export function cloudRow(account: PhoneSpaces, person: string | null | undefined, macName: string): { label: string; detail: string | null } | null {
  if (account.state !== "ready") return account.state === "signed-out" ? { label: `Signed out on ${macName}`, detail: null } : null;
  return { label: person?.trim() || "Signed in", detail: account.offline ? `Via ${macName}, which can't reach OpenOrc Cloud now` : `Via ${macName}` };
}

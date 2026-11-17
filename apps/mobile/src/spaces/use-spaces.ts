import { CLOUD_THREADS, type OrganizationAccess, type Space } from "@openorc/protocol";
import { useRpc } from "../client";
import { useShares } from "../connection/use-shares";
import { useOwnCloud } from "../cloud/use-own-cloud";
import { useChosenSpace } from "./space-choice";

/**
 * The OpenOrc account as this phone reads it: from a session of its own, or through the Mac it shows:
 *   none        no session of its own, and the Mac shares no cloud threads, has no account, or has not answered yet:
 *               Home is the Mac's alone
 *   signed-out  nobody is signed in on the Mac
 *   ready       the person's spaces, the one Home shows, and whether an organization is open to them
 */
export type PhoneSpaces =
  | { state: "none" | "signed-out" }
  | {
      state: "ready";
      spaces: readonly Space[];
      /** The space Home shows: the one chosen on this phone while the person still has it, else Personal. */
      current: Space;
      /** The person's standing in every organization; absent from a server that does not say. */
      access: OrganizationAccess | null;
      /** The Mac cannot reach OpenOrc Cloud now: what shows is what it last heard. */
      offline: boolean;
      /** The person's own id on OpenOrc Cloud. */
      userId: string;
    };

/** What a space is called among the others, as the Mac's space menu names it: the organization's name, or Personal. */
export const spaceName = (space: Space): string => (space.kind === "organization" ? space.name : "Personal");

/** What the phone calls a space, in Home's bar and its Spaces sheet, as the Mac's sidebar heads it: the organization's name, or OpenOrc. */
export const titleName = (space: Space): string => (space.kind === "organization" ? space.name : "OpenOrc");

/** Whether the person is shut out of an organization's work now: frozen, or past the day of grace the server gave. */
export function closedToPerson(space: Space, access: OrganizationAccess | null, now: number): boolean {
  if (space.kind !== "organization" || !access) return false;
  return access.state === "frozen" || (access.state === "grace" && now >= access.until);
}

export function useSpaces(): PhoneSpaces {
  const own = useOwnCloud();
  const shares = useShares(CLOUD_THREADS);
  const reads = own || shares === true;
  const status = useRpc("spaces.status", {}, { enabled: reads, refetchInterval: 60_000 }).data;
  const chosen = useChosenSpace();
  if (!reads || !status) return { state: "none" };
  if (status.state === "signed-out") return { state: "signed-out" };
  if (status.state !== "ready") return { state: "none" };
  const personal = status.spaces.find((space) => space.id === status.personalSpaceId);
  const current = status.spaces.find((space) => space.id === chosen) ?? personal;
  if (!current) return { state: "none" };
  return { state: "ready", spaces: status.spaces, current, access: status.organizationAccess ?? null, offline: status.reach !== "live", userId: status.userId };
}

import type { HostedSpaces } from "./index.js";
import type { Session } from "./session.js";
import { SOCKET, wireTopics } from "./wire.js";

/** The organizations a person is in. */
export function organizationsOf(spaces: Pick<HostedSpaces, "status">): string[] {
  const status = spaces.status();
  return status.state === "ready" ? status.spaces.filter((space) => space.kind === "organization").map((space) => space.id) : [];
}

/**
 * Calls `listener` with an organization where something may wait for this person's computer: one a notice of `topic`
 * names, and every one on a new connection, which may have missed notices or come after the computer was off.
 */
export function watchPersonNotices(session: Session, spaces: Pick<HostedSpaces, "status">, topic: string, listener: (spaceId: string) => void): void {
  session.onSocket(SOCKET.changed, (body) => {
    const parsed = wireTopics.safeParse(body);
    if (parsed.success && parsed.data.organizationId && parsed.data.topics.includes(topic)) listener(parsed.data.organizationId);
  });
  session.onChange((change) => {
    if (change === "connected") for (const spaceId of organizationsOf(spaces)) listener(spaceId);
  });
}

/**
 * Whether the person is at this computer, as OpenOrc Cloud asks when it would alert their phone: someone used its
 * keyboard or mouse in the last two minutes. A device with no such reading answers at once that nobody is, so the server
 * never waits on it; a reading that fails reads the same. The server asks only the person's own sockets.
 */
import type { HostedDeps } from "./index.js";
import type { Session } from "./session.js";
import { SOCKET } from "./wire.js";

export function answerPresence(session: Session, inUse: HostedDeps["inUse"]): void {
  session.onSocket(SOCKET.presence, (_body, answer) => {
    if (!answer) return;
    const reading = inUse ? inUse().catch(() => false) : Promise.resolve(false);
    void reading.then((value) => answer({ inUse: value === true }));
  });
}

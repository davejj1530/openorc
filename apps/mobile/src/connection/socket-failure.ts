/**
 * A link's socket that did not open. `status` is the HTTP status the host's address answered the upgrade with, or null
 * when nothing answered: a server is there, but no OpenOrc host listens behind it.
 */
export class SocketFailed extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "The socket failed." : `The address answered ${status} instead of the link.`);
  }
}

/**
 * The HTTP status in a WebSocket failure's message: iOS reports "Received bad response code from server: 502."
 * (SocketRocket), Android "Expected HTTP 101 response but was '502 Bad Gateway'" (OkHttp).
 */
export function answeredStatus(message: unknown): number | null {
  if (typeof message !== "string") return null;
  const found = /bad response code from server:?\s*(\d{3})/i.exec(message) ?? /expected HTTP 101 response but was '(\d{3})/i.exec(message);
  return found ? Number(found[1]) : null;
}

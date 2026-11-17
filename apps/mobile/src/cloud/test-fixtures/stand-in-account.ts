import { createHosted, type Hosted, type HostedDeps } from "@openorc/hosted";
import { liveSocketOf } from "@openorc/hosted/socket";
import type { StandIn } from "@openorc/hosted/testing";
import { io } from "socket.io-client";
import { expect, vi } from "vitest";

export const quiet = { info: () => undefined, warn: () => undefined };

/** The socket a host opens, as the apps open it. */
export const socket = liveSocketOf(io);

/**
 * An account on the stand-in signed in as `email` through its sign-in page, as a Mac signs in: for a test's Mac, or for
 * a phone's own cloud where the test needs one without a grant. `overrides` hands in what else the host has.
 */
export async function accountOn(stand: StandIn, email: string, overrides: Partial<HostedDeps> = {}): Promise<Hosted> {
  let stored: string | null = null;
  let resolve: (query: string) => void = () => undefined;
  const hosted = createHosted({
    server: stand.url,
    session: { load: async () => stored, save: async (value) => void (stored = value) },
    kept: { load: () => null, save: () => undefined },
    projects: () => [],
    fetch,
    connect: socket,
    push: () => undefined,
    notify: () => undefined,
    browser: {
      awaitReturn: async () => ({ port: 41_000, query: new Promise<string>((done) => (resolve = done)), redirect: () => undefined, close: () => undefined }),
      open: (url) => {
        if (new URL(url).pathname === "/sign-in") resolve(new URL(stand.signInPage(url, email)).search.slice(1));
      },
    },
    deviceName: "OpenOrc on this Mac",
    now: Date.now,
    log: quiet,
    ...overrides,
  });
  await hosted.start();
  await hosted.account.signIn();
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-in", email }));
  return hosted;
}

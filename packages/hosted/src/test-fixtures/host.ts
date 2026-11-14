import { expect, vi } from "vitest";
import type { Hosted, HostedDeps, HostedNotice } from "../index.js";
import type { StandIn } from "../testing/stand-in.js";

/** One device's storage, kept across the hosts a test makes on it, as protected storage and the settings table outlive a launch. */
export interface Device {
  stored: string | null;
  kept: string | null;
  /** The kept thread rows. */
  threads: string | null;
  /** This device's projects, as the core lists them. */
  projects: { id: string; remote: string | null }[];
}

/** What a host did that a test reads: every log line, push and socket it opened, and every write in order. */
export interface Seen {
  logs: string[];
  pushes: unknown[];
  notices: HostedNotice[];
  timeline: string[];
  sockets: { closed: boolean }[];
}

export const newDevice = (): Device => ({ stored: null, kept: null, threads: null, projects: [] });

/**
 * The person's browser, with this device's loopback held in memory. On OpenOrc's sign-in page the person signs in as
 * `person` (none leaves the page open); any other page goes to `other`. `back` is the browser arriving at a loopback
 * address.
 */
export interface TestBrowser extends NonNullable<HostedDeps["browser"]> {
  opened: string[];
  person: string | null;
  back(url: string): void;
}

export function testBrowser(stand: StandIn, other: (url: string, browser: TestBrowser) => void = () => undefined): TestBrowser {
  const waiting = new Map<number, { path: string; resolve(query: string): void; reject(error: Error): void }>();
  let port = 40_000;
  const browser: TestBrowser = {
    opened: [],
    person: null,
    awaitReturn: async (path) => {
      const at = ++port;
      const query = new Promise<string>((resolve, reject) => waiting.set(at, { path, resolve, reject }));
      query.catch(() => undefined);
      return { port: at, query, close: () => waiting.get(at)?.reject(new Error("")) };
    },
    open: (url) => {
      browser.opened.push(url);
      if (new URL(url).pathname !== "/sign-in") return other(url, browser);
      if (browser.person) browser.back(stand.signInPage(url, browser.person));
    },
    back: (url) => {
      const at = new URL(url);
      const listener = waiting.get(Number(at.port));
      if (listener?.path === at.pathname) listener.resolve(at.search.slice(1));
    },
  };
  return browser;
}

/** Signs the host in as `email` through its browser, as the person would on the sign-in page, and waits for the session. */
export async function signInAs(hosted: Hosted, browser: TestBrowser, email: string): Promise<void> {
  browser.person = email;
  await hosted.account.signIn();
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-in", email }));
}

/** The deps a host hands the package, on this device, against the stand-in over real HTTP. */
export function hostDeps(stand: StandIn, device: Device, overrides: Partial<HostedDeps> = {}): { deps: HostedDeps; seen: Seen; browser: TestBrowser } {
  const browser = testBrowser(stand);
  const seen: Seen = { logs: [], pushes: [], notices: [], timeline: [], sockets: [] };
  const deps: HostedDeps = {
    server: stand.url,
    session: {
      load: async () => device.stored,
      save: async (value) => {
        seen.timeline.push(value === null ? "session forgotten" : "session saved");
        device.stored = value;
      },
    },
    kept: {
      load: (part) => (part === "account" ? device.kept : device.threads),
      save: (part, json) => {
        if (part === "threads") return void (device.threads = json);
        seen.timeline.push(json === null ? "kept forgotten" : "kept saved");
        device.kept = json;
      },
    },
    projects: () => device.projects,
    fetch: async (input, init) => {
      seen.timeline.push(`request ${new URL(String(input)).pathname}`);
      return fetch(input, init);
    },
    connect: (url, token) => {
      const socket = stand.connect(url, token);
      const record = { closed: false };
      seen.sockets.push(record);
      return {
        onState: (listener) => socket.onState(listener),
        on: (event, listener) => socket.on(event, listener),
        ask: (event, body) => socket.ask(event, body),
        close: () => {
          record.closed = true;
          socket.close();
        },
      };
    },
    push: (push) => void seen.pushes.push(push),
    notify: (notice) => void seen.notices.push(notice),
    browser,
    deviceName: "OpenOrc on this Mac",
    now: Date.now,
    log: { info: (line) => void seen.logs.push(line), warn: (line) => void seen.logs.push(line) },
    ...overrides,
  };
  return { deps, seen, browser };
}

/** The token a device holds, read the way only a test may. */
export function storedToken(device: Device): string {
  return (JSON.parse(device.stored ?? "{}") as { token: string }).token;
}

/**
 * Connecting the person's GitHub, every trip of it behind one call. GitHub returns the browser to the server, which
 * sends it on to this device's loopback (`HostedDeps.browser`); the device posts the query it caught back with its own
 * token, and the server, which put its state in that query, finishes the step. The query is passed on unread.
 *
 *   for up to three trips:
 *     listen on loopback, then ask the server to start installing OpenOrc's GitHub app, with the port
 *     settled at once (an installation the person owns is connected without GitHub): done, or its words
 *     else open GitHub's page, wait for the browser's return, and post the query to finish the step
 *     a link step that linked goes round again, for the install it was needed for
 *
 * What is under way, or the last that failed, is `work`. The account reads GitHub and the projects again once a trip
 * settles, whatever came of it.
 */
import type { GithubWork } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import type { Requests, Session } from "./session.js";
import { ROUTES, type WireGithubStart } from "./wire.js";

/** The path the server sends the browser on to, on this device's loopback. */
const RETURN_PATH = "/github-return";
/** At most this many pages of GitHub's in one connect: a link, then an install, and one spare. */
const TRIPS = 3;
const NO_BROWSER = "This device can't open GitHub's page.";

/** How a finished step went, in words for the person; null when it connected. */
const LINK_WORDS: Record<string, string | null> = {
  linked: null,
  denied: "GitHub sign-in was cancelled.",
  expired: "That took too long. Connect GitHub again.",
  taken: "That GitHub account is linked to another OpenOrc account.",
};
const INSTALL_WORDS: Record<string, string | null> = {
  connected: null,
  requested: "Your GitHub organization's owners were asked to approve OpenOrc. Connect again once they do.",
  expired: "That took too long. Connect GitHub again.",
  taken: "Another OpenOrc space already uses that GitHub installation.",
  unverified: "GitHub didn't show that installation as yours. Connect it from the GitHub account that owns it.",
};
const FAILED = "GitHub didn't connect. Try again.";

interface GithubDeps extends Pick<HostedDeps, "browser"> {
  session: Session;
  requests?: Requests;
  /** The work changed: the windows read the account again. */
  changed(): void;
  /** A trip settled: GitHub and the projects are read again. */
  landed(): Promise<void>;
}

export class GithubConnect {
  #work: GithubWork | null = null;
  /** Ends the trip under way: closes its listener, so its wait rejects as a cancel. */
  #stop: (() => void) | null = null;

  constructor(private readonly deps: GithubDeps) {}

  get work(): GithubWork | null {
    return this.#work;
  }

  /** Starts connecting; resolves once GitHub's first page is open, or rejects in words when it could not start. The rest goes on in `work`. */
  async connect(another = false): Promise<void> {
    this.cancel();
    const browser = this.deps.browser;
    if (!browser) throw new Error(NO_BROWSER);
    let live = true;
    this.#stop = () => {
      live = false;
    };
    this.#set({ state: "waiting" });
    const first = await this.#trip(browser, () => live, another).catch((error: unknown) => this.#failed(error, live));
    if (!live || first === "done") return;
    void this.#finish(browser, first, () => live, another);
  }

  cancel(): void {
    this.#stop?.();
    this.#stop = null;
    if (this.#work) this.#set(null);
  }

  async disconnect(): Promise<void> {
    await this.deps.session.request(ROUTES.githubUnlink);
    await this.deps.landed();
  }

  /** Signed out: the trip stops and nothing of it is remembered. */
  forget(): void {
    this.#stop?.();
    this.#stop = null;
    this.#work = null;
  }

  /** The trips after the first page opened: each waits on the browser, finishes its step, and a link goes round again. */
  async #finish(browser: NonNullable<HostedDeps["browser"]>, first: Trip, live: () => boolean, another: boolean): Promise<void> {
    try {
      let trip: Trip | "done" = first;
      for (let count = 1; trip !== "done"; count++) {
        const words = await this.#step(trip, live);
        if (!live()) return;
        if (words !== "again" || count >= TRIPS) return this.#settle(words === "again" ? FAILED : words, live);
        trip = await this.#trip(browser, live, another);
      }
      this.#settle(null, live);
    } catch (error) {
      this.#failed(error, live());
    }
  }

  /** One trip: listen, start the step, and open GitHub's page; `done` when the server settled it without GitHub. */
  async #trip(browser: NonNullable<HostedDeps["browser"]>, live: () => boolean, another: boolean): Promise<Trip | "done"> {
    const waiting = await browser.awaitReturn(RETURN_PATH, 15 * 60_000);
    if (!live()) {
      waiting.close();
      throw new Error("");
    }
    const stop = this.#stop;
    this.#stop = () => {
      stop?.();
      waiting.close();
    };
    let start: WireGithubStart;
    try {
      start = await (this.deps.requests ?? this.deps.session).request(ROUTES.githubStart, { port: waiting.port, ...(another && { another: true }) });
    } catch (error) {
      waiting.close();
      throw error;
    }
    if (start.kind === "settled") {
      waiting.close();
      const words = INSTALL_WORDS[start.outcome];
      this.#settle(words === undefined ? FAILED : words, live);
      return "done";
    }
    if (live()) browser.open(start.url);
    return { step: start.step, query: waiting.query };
  }

  /** Posts the caught query to finish a step: `again` for a link that linked, else the words for how it went (null: connected). */
  async #step(trip: Trip, live: () => boolean): Promise<string | null | "again"> {
    const query = await trip.query;
    if (!live()) throw new Error("");
    if (trip.step === "link") {
      const { outcome } = await this.deps.session.request(ROUTES.githubLinkFinish, { query });
      return outcome === "linked" ? "again" : (LINK_WORDS[outcome] ?? FAILED);
    }
    const { outcome } = await this.deps.session.request(ROUTES.githubInstallFinish, { query });
    return INSTALL_WORDS[outcome] === undefined ? FAILED : INSTALL_WORDS[outcome];
  }

  #settle(words: string | null, live: () => boolean): void {
    if (!live()) return;
    this.#stop = null;
    this.#set(words ? { state: "failed", error: words } : null);
    void this.deps.landed();
  }

  /** Words for why it failed; a cancel (an empty message) leaves none. */
  #failed(error: unknown, live: boolean): "done" {
    if (!live) return "done";
    this.#stop = null;
    const words = error instanceof Error ? error.message : String(error);
    this.#set(words ? { state: "failed", error: words } : null);
    return "done";
  }

  #set(work: GithubWork | null): void {
    this.#work = work;
    this.deps.changed();
  }
}

/** A page of GitHub's opened, and the browser's return it waits on. */
interface Trip {
  step: "link" | "install";
  query: Promise<string>;
}

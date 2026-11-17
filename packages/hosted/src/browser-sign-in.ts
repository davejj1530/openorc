/**
 * Signing in to OpenOrc through the browser, one sign-in at a time. The browser comes back to this device's loopback
 * (`HostedDeps.browser`), as GitHub's pages do.
 *
 *   listen on loopback, then ask the server to start, with the port and the challenge of a verifier only this holds
 *   open the page it answers; the person signs in there, and the page sends the browser back with a code
 *   trade the code and the verifier for the session's token, which the session adopts
 *
 * The verifier, the code and the token are never logged, shown or kept in `work`; the page's address may be shown.
 * Asked again while a page waits, the same page opens again. Every way it ends that is not a sign-in (a cancel, the
 * browser not coming back, the server out of reach or refusing) leaves `work` failed with words, a cancel with none.
 */
import type { BrowserSignIn } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import type { Session } from "./session.js";
import { ROUTES } from "./wire.js";

/** The path the sign-in page sends the browser back to, on this device's loopback. */
const RETURN_PATH = "/signed-in";
/** As long as the server keeps a sign-in request. */
const REQUEST_MS = 10 * 60_000;
const NO_BROWSER = "This device can't open OpenOrc's sign-in page.";
const NOT_THIS = "That sign-in wasn't this app's. Try again.";
type BrowserReturn = Awaited<ReturnType<NonNullable<HostedDeps["browser"]>["awaitReturn"]>>;

interface SignInDeps extends Pick<HostedDeps, "browser" | "deviceName"> {
  session: Session;
  /** The work changed: the windows read the account again. */
  changed(): void;
}

export class BrowserSignInTrip {
  #work: BrowserSignIn | null = null;
  #starting: Promise<void> | null = null;
  /** Ends the trip under way: closes its listener, so its wait rejects as a cancel. */
  #stop: ((reason?: string) => void) | null = null;

  constructor(private readonly deps: SignInDeps) {}

  get work(): BrowserSignIn | null {
    return this.#work;
  }

  /** Resolves once the page is open, or once it could not start, which `work` then says. Nothing to do when signed in. */
  start(): Promise<void> {
    if (this.deps.session.state.signedIn) return Promise.resolve();
    const work = this.#work;
    if (work?.state === "waiting") {
      this.deps.browser?.open(work.page);
      return Promise.resolve();
    }
    this.#starting ??= this.#begin().finally(() => (this.#starting = null));
    return this.#starting;
  }

  cancel(): void {
    this.forget();
    this.deps.changed();
  }

  /** Signed in, or the host is closing: the trip stops and nothing of it is remembered. */
  forget(): void {
    this.#stop?.();
    this.#stop = null;
    this.#work = null;
  }

  async #begin(): Promise<void> {
    const browser = this.deps.browser;
    if (!browser) return this.#settle(NO_BROWSER);
    const { verifier, challenge } = await signInVerifier();
    let live = true;
    this.#stop = () => void (live = false);
    try {
      const waiting = await browser.awaitReturn(RETURN_PATH, REQUEST_MS, true);
      if (!live) return waiting.close();
      this.#stop = () => {
        live = false;
        waiting.close();
      };
      const start = await this.deps.session.anonymous(ROUTES.appSignInStart, { port: waiting.port, challenge, device: this.deps.deviceName }).catch((error: unknown) => {
        waiting.close();
        throw error;
      });
      if (!live) return this.#cancel(start.request, verifier);
      this.#stop = (reason = "This sign-in was canceled. Start again from OpenOrc.") => {
        live = false;
        waiting.redirect(resultPage(start.resultUrl, reason));
        waiting.close();
        this.#cancel(start.request, verifier);
      };
      this.#set({ state: "waiting", page: start.url });
      browser.open(start.url);
      void this.#finish(start, verifier, waiting, () => live);
    } catch (error) {
      if (live) {
        this.#stop?.(wordsOf(error));
        this.#settle(wordsOf(error));
      }
    }
  }

  /** Waits on the browser's return, then trades its code for the token. */
  async #finish(start: { request: string; resultUrl: string }, verifier: string, waiting: BrowserReturn, live: () => boolean): Promise<void> {
    try {
      const { request } = start;
      const back = new URLSearchParams(await waiting.query);
      const code = back.get("code");
      if (back.get("request") !== request || !code) throw new Error(NOT_THIS);
      const { token } = await this.deps.session.anonymous(ROUTES.appSignInFinish, { request, code, verifier });
      await this.deps.session.adopt(token, live);
      if (live()) {
        this.#settle(null);
        waiting.redirect(resultPage(start.resultUrl));
      }
    } catch (error) {
      if (live()) {
        this.#stop?.(wordsOf(error));
        this.#settle(wordsOf(error));
      }
    }
  }

  #cancel(request: string, verifier: string): void {
    void this.deps.session.anonymous(ROUTES.appSignInCancel, { request, verifier }).catch(() => undefined);
  }

  /** The trip is over: signed in (no words), or the words for why not. */
  #settle(words: string | null): void {
    this.#stop = null;
    this.#set(words ? { state: "failed", error: words } : null);
  }

  #set(work: BrowserSignIn | null): void {
    this.#work = work;
    this.deps.changed();
  }
}

function resultPage(address: string, failure?: string): string {
  const url = new URL(address);
  url.searchParams.set("outcome", failure ? "failed" : "signed-in");
  if (failure) url.searchParams.set("message", failure.slice(0, 300));
  return url.toString();
}

/**
 * The pair a sign-in is bound to: a verifier only this device holds, and its challenge (SHA-256, base64url), which the
 * server keeps. Only the verifier finishes the sign-in, so a code caught on its way is of no use to anyone else.
 */
export async function signInVerifier(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64url(32);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function randomBase64url(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

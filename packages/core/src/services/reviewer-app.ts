import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { settings, type Db } from "@openorc/db";
import { GitHubAppClient, GitHubPulls, reviewerAppManifest, type GitHubAppCredentials, type GitHubAppIdentity, type ReviewSubmission } from "@openorc/git";
import type { ReviewerAppStatus } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const SETTING = "github.reviewerApp";
const HOMEPAGE = "https://openorc.app";
/** How long the setup page waits for GitHub before it closes. */
const SETUP_TIMEOUT_MS = 15 * 60_000;
const PAGE_STYLE = "body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:30rem;margin:18vh auto;padding:0 1.5rem;color:#222}button{font:inherit;padding:.4rem .9rem}";

interface StoredApp extends GitHubAppIdentity {
  allowApprove: boolean;
}

interface PendingSetup {
  state: string;
  url: string;
  server: http.Server;
  timer: NodeJS.Timeout;
  /** GitHub sent its one-time code back, which is traded once: the setup's pages are done. */
  exchanging: boolean;
}

export interface ReviewerAppOptions {
  /** Keeps the app's private key in the OS keychain. Without it, no app can be set up. */
  secrets?: ProtectedSecretStore;
  github?: GitHubAppClient;
  /** The signed-in GitHub login, to name the app after; null when unknown. */
  login?: () => Promise<string | null>;
  invalidate(keys: string[]): void;
}

/** The app's name on GitHub, where names are unique and at most 34 characters. */
export function reviewerAppName(login: string | null): string {
  return login ? `${login.slice(0, 25)} reviewer` : `OpenOrc reviewer ${randomBytes(2).toString("hex")}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function sendPage(response: http.ServerResponse, status: number, title: string, body: string, headers: Record<string, string> = {}): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  response
    .writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      ...headers,
    })
    .end(html);
}

/**
 * The GitHub App that posts reviews for the user. Setup follows GitHub's
 * create-from-manifest flow: a page served on loopback posts the app's
 * description to GitHub, GitHub sends the browser back with a one-time code,
 * and the code buys the app's private key, which goes straight to the
 * keychain. Each person creates their own app, since OpenOrc has no server
 * that could keep a shared app's key.
 */
export class ReviewerAppService {
  private readonly github: GitHubAppClient;
  private pending: PendingSetup | null = null;
  private error: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly options: ReviewerAppOptions,
  ) {
    this.github = options.github ?? new GitHubAppClient();
  }

  status(): ReviewerAppStatus {
    const app = this.stored();
    return {
      app: app
        ? { name: app.name, slug: app.slug, owner: app.owner, login: `${app.slug}[bot]`, installUrl: `https://github.com/apps/${app.slug}/installations/new`, allowApprove: app.allowApprove }
        : null,
      setupUrl: this.pending?.url ?? null,
      error: this.error,
    };
  }

  /** Starts setup and returns the page that continues it in the browser. A new setup replaces an unfinished one. */
  async setup(): Promise<{ url: string }> {
    if (!this.options.secrets) throw new Error("Protected storage is unavailable, so the app's key couldn't be kept safe.");
    this.cancel();
    this.error = null;
    const login = await (this.options.login ?? (() => new GitHubPulls().viewer(os.homedir())))().catch(() => null);
    const name = reviewerAppName(login);
    const state = randomBytes(24).toString("hex");
    const server = http.createServer((request, response) => {
      this.answer(request, response, name).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const timer = setTimeout(() => this.cancel(), SETUP_TIMEOUT_MS);
    timer.unref();
    this.pending = { state, url: `http://127.0.0.1:${port}/reviewer-app/start?state=${state}`, server, timer, exchanging: false };
    this.changed();
    return { url: this.pending.url };
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.close(pending);
    this.changed();
  }

  configure(allowApprove: boolean): void {
    const app = this.stored();
    if (!app) throw new Error("Set up a reviewer app first.");
    settings.set(this.db, SETTING, JSON.stringify({ ...app, allowApprove }));
    this.changed();
  }

  /** Forgets the app and its key here. The app itself stays on GitHub until it is deleted there. */
  async remove(): Promise<void> {
    this.cancel();
    // An encrypted empty string records an intentional clear.
    await this.options.secrets?.save("");
    settings.remove(this.db, SETTING);
    this.error = null;
    this.changed();
  }

  /** Posts a review as the app. Approving needs the user's explicit permission, since it can satisfy required reviews. */
  async submitReview(url: string, review: ReviewSubmission): Promise<{ url: string | null }> {
    const app = this.stored();
    if (!app) throw new Error("Set up a reviewer app in Settings first.");
    if (review.event === "approve" && !app.allowApprove) throw new Error("Your reviewer app isn't allowed to approve. Turn that on in Settings.");
    const pem = await this.options.secrets?.load();
    if (!pem) throw new Error("The reviewer app's key is missing on this device. Set the app up again in Settings.");
    return this.github.submitReview({ ...app, pem }, url, review);
  }

  shutdown(): void {
    this.cancel();
  }

  private stored(): StoredApp | null {
    const saved = settings.get(this.db, SETTING);
    return saved ? (JSON.parse(saved) as StoredApp) : null;
  }

  /** Serves the two pages of setup, and nothing to anyone without its state. Loopback only, and only under its own host name. */
  private async answer(request: http.IncomingMessage, response: http.ServerResponse, name: string): Promise<void> {
    const port = request.socket.localPort;
    if (!port || request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const pending = this.pending;
    if (!pending || pending.exchanging || url.searchParams.get("state") !== pending.state) {
      sendPage(response, 403, "This link has expired", "<p>Start setting up the reviewer app again from OpenOrc.</p>");
      return;
    }
    if (url.pathname === "/reviewer-app/start") this.sendManifest(response, pending, name, port);
    else if (url.pathname === "/reviewer-app/created") await this.finish(response, pending, url.searchParams.get("code"));
    else response.writeHead(404).end();
  }

  /** A form that posts the app's description to GitHub, submitted as soon as the page loads. */
  private sendManifest(response: http.ServerResponse, pending: PendingSetup, name: string, port: number): void {
    const manifest = reviewerAppManifest({ name, redirectUrl: `http://127.0.0.1:${port}/reviewer-app/created`, homepage: HOMEPAGE });
    const nonce = randomBytes(16).toString("base64");
    const form = `<form method="post" action="https://github.com/settings/apps/new?state=${pending.state}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><p>Taking you to GitHub to create your reviewer app.</p><button type="submit">Continue to GitHub</button></form><script nonce="${nonce}">document.forms[0].submit();</script>`;
    sendPage(response, 200, "Create your reviewer app", form, {
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action https://github.com`,
    });
  }

  /**
   * Trades GitHub's one-time code for the app, keeps its key, then sends the browser on to choose repositories. Setup
   * can be cancelled until GitHub answers; the app it created then goes unused.
   */
  private async finish(response: http.ServerResponse, pending: PendingSetup, code: string | null): Promise<void> {
    pending.exchanging = true;
    const app = await this.trade(code);
    try {
      if (this.pending !== pending) {
        const unused = app instanceof Error ? "" : ` You can delete it in <a href="https://github.com/settings/apps/${encodeURIComponent(app.slug)}">your GitHub settings</a>.`;
        sendPage(response, 409, "Setup was cancelled", `<p>OpenOrc didn't keep the app.${unused}</p>`);
        return;
      }
      this.pending = null;
      if (app instanceof Error) throw app;
      await this.options.secrets!.save(app.pem);
      const stored: StoredApp = { id: app.id, slug: app.slug, name: app.name, owner: app.owner, allowApprove: false };
      settings.set(this.db, SETTING, JSON.stringify(stored));
      response.writeHead(302, { location: `https://github.com/apps/${app.slug}/installations/new`, "cache-control": "no-store" }).end();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      sendPage(response, 500, "The reviewer app wasn't set up", `<p>${escapeHtml(this.error)}</p><p>Return to OpenOrc and try again.</p>`);
    } finally {
      // Close once the browser has the answer, so the redirect is never cut off.
      if (response.writableFinished) this.close(pending);
      else response.once("close", () => this.close(pending));
      this.changed();
    }
  }

  /** The app GitHub's one-time code buys, or why it couldn't. */
  private async trade(code: string | null): Promise<GitHubAppCredentials | Error> {
    if (!code) return new Error("GitHub didn't send the app back.");
    return this.github.exchangeManifestCode(code).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  }

  private close(pending: PendingSetup): void {
    clearTimeout(pending.timer);
    pending.server.close();
    pending.server.closeIdleConnections();
  }

  private changed(): void {
    this.options.invalidate(["reviewer-app"]);
  }
}

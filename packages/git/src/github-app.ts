import { createSign } from "node:crypto";
import { githubErrorReason, pullRequestRepository, reviewPayload, type ReviewSubmission } from "./github.js";

const API = "https://api.github.com";
const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "OpenOrc" };

/** A GitHub App someone created to post reviews. Nothing here is secret. */
export interface GitHubAppIdentity {
  id: number;
  slug: string;
  name: string;
  /** The account that owns the app. */
  owner: string;
}

/** The identity with the app's private key, which signs everything the app does. */
export interface GitHubAppCredentials extends GitHubAppIdentity {
  pem: string;
}

/**
 * The app OpenOrc asks GitHub to create: it may review pull requests and
 * nothing else, and it has no webhook, since nothing listens for one. Public
 * so that an organization can install it too; only the key holder can act.
 */
export function reviewerAppManifest(input: { name: string; redirectUrl: string; homepage: string }): Record<string, unknown> {
  return {
    name: input.name,
    url: input.homepage,
    description: "Posts pull request reviews drafted in OpenOrc.",
    public: true,
    redirect_url: input.redirectUrl,
    hook_attributes: { url: input.homepage, active: false },
    default_permissions: { pull_requests: "write" },
    default_events: [],
  };
}

/** Proof of the app's identity for ten minutes, signed with its private key. The issue time is backdated for clock drift. */
export function appJwt(appId: number, pem: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000) - 60;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issued, exp: issued + 600, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(pem, "base64url")}`;
}

interface Call {
  method?: string;
  token?: string;
  body?: unknown;
}

/** GitHub's REST API as a GitHub App calls it: with the app's own tokens rather than the user's gh login. */
export class GitHubAppClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The app GitHub created from a manifest, for the code it returned. A code works once, within an hour. */
  async exchangeManifestCode(code: string): Promise<GitHubAppCredentials> {
    const app = (await this.call(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" }, "GitHub couldn't finish creating the app")) as {
      id: number;
      slug: string;
      name: string;
      owner: { login: string } | null;
      pem: string;
    };
    return { id: app.id, slug: app.slug, name: app.name, owner: app.owner?.login ?? "", pem: app.pem };
  }

  /** Posts one review as the app, which must be installed on the pull request's repository. */
  async submitReview(app: GitHubAppCredentials, url: string, review: ReviewSubmission): Promise<{ url: string | null }> {
    const { host, owner, repo } = pullRequestRepository(url);
    if (host !== "github.com") throw new Error("The reviewer app works with repositories on github.com.");
    const number = /\/pull\/(\d+)/.exec(url)![1];
    const token = await this.installationToken(app, owner, repo);
    const posted = (await this.call(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { method: "POST", token, body: reviewPayload(review) }, "GitHub didn't accept the review")) as {
      html_url?: string;
    };
    return { url: posted.html_url ?? null };
  }

  /** A token that lets the app review pull requests in this one repository for the next hour. */
  private async installationToken(app: GitHubAppCredentials, owner: string, repo: string): Promise<string> {
    const jwt = appJwt(app.id, app.pem);
    const installation = (await this.call(`/repos/${owner}/${repo}/installation`, { token: jwt }, `The reviewer app isn't installed on ${owner}/${repo}`)) as { id: number };
    const access = (await this.call(
      `/app/installations/${installation.id}/access_tokens`,
      { method: "POST", token: jwt, body: { repositories: [repo], permissions: { pull_requests: "write" } } },
      "GitHub wouldn't give the reviewer app access",
    )) as { token: string };
    return access.token;
  }

  private async call(path: string, call: Call, failure: string): Promise<unknown> {
    const headers: Record<string, string> = { ...HEADERS, ...(call.token ? { authorization: `Bearer ${call.token}` } : {}) };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetcher(`${API}${path}`, { method: call.method ?? "GET", headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }) });
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as unknown;
    if (response.status === 404 && path.endsWith("/installation")) throw new Error(`${failure}. Choose repositories for it in Settings.`);
    if (response.status === 401) throw new Error("GitHub didn't accept the reviewer app's key. Set the app up again in Settings.");
    const reason = githubErrorReason(text);
    throw new Error(reason ? `${failure}: ${reason}` : `${failure} (HTTP ${response.status}).`);
  }
}

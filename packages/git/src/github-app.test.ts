import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppClient, appJwt, reviewerAppManifest } from "./github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const app = { id: 42, slug: "ada-reviewer", name: "ada reviewer", owner: "ada", pem };

/** Answers GitHub API calls from a table keyed by method and path, and records each request. */
function fakeGitHub(answers: Record<string, { status?: number; body: unknown }>) {
  const requests: { method: string; path: string; authorization: string | undefined; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const headers = init.headers as Record<string, string>;
    requests.push({ method, path, authorization: headers["authorization"], body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${path}`] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, requests };
}

describe("reviewer app", () => {
  it("asks GitHub for an app that can only review pull requests", () => {
    expect(reviewerAppManifest({ name: "ada reviewer", redirectUrl: "http://127.0.0.1:5000/created", homepage: "https://openorc.app" })).toEqual({
      name: "ada reviewer",
      url: "https://openorc.app",
      description: "Posts pull request reviews drafted in OpenOrc.",
      public: true,
      redirect_url: "http://127.0.0.1:5000/created",
      hook_attributes: { url: "https://openorc.app", active: false },
      default_permissions: { pull_requests: "write" },
      default_events: [],
    });
  });

  it("signs a short-lived token GitHub can verify with the app's public key", () => {
    const token = appJwt(42, pem, Date.parse("2026-09-28T12:00:00Z"));
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { iat: number; exp: number; iss: number };
    expect(claims.iss).toBe(42);
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.iat).toBe(Date.parse("2026-09-28T12:00:00Z") / 1000 - 60);
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature!, "base64url")).toBe(true);
  });

  it("trades the code GitHub returns for the new app's key", async () => {
    const github = fakeGitHub({
      "POST /app-manifests/abc/conversions": { status: 201, body: { id: 42, slug: "ada-reviewer", name: "ada reviewer", owner: { login: "ada" }, pem, client_secret: "unused" } },
    });
    expect(await new GitHubAppClient(github.fetcher).exchangeManifestCode("abc")).toEqual(app);
    expect(github.requests[0]!.authorization).toBeUndefined();
  });

  it("posts as the app with a token limited to the one repository", async () => {
    const github = fakeGitHub({
      "GET /repos/acme/app/installation": { body: { id: 7 } },
      "POST /app/installations/7/access_tokens": { status: 201, body: { token: "installation-token" } },
      "POST /repos/acme/app/pulls/3/reviews": { body: { html_url: "https://github.com/acme/app/pull/3#pullrequestreview-9" } },
    });
    const review = { commitId: "c".repeat(40), event: "request_changes" as const, body: "Review by Claude Opus 5.5.", comments: [] };
    expect(await new GitHubAppClient(github.fetcher).submitReview(app, "https://github.com/acme/app/pull/3", review)).toEqual({ url: "https://github.com/acme/app/pull/3#pullrequestreview-9" });
    const [lookup, access, posted] = github.requests;
    expect(lookup!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(access).toMatchObject({ body: { repositories: ["app"], permissions: { pull_requests: "write" } } });
    expect(posted).toMatchObject({ authorization: "Bearer installation-token", body: { commit_id: "c".repeat(40), event: "REQUEST_CHANGES", body: "Review by Claude Opus 5.5.", comments: [] } });
  });

  it("says where to fix it when the app is missing from the repository or no longer accepted", async () => {
    const missing = fakeGitHub({});
    await expect(new GitHubAppClient(missing.fetcher).submitReview(app, "https://github.com/acme/app/pull/3", { commitId: "c".repeat(40), event: "comment", body: "", comments: [] })).rejects.toThrow(
      "The reviewer app isn't installed on acme/app. Choose repositories for it in Settings.",
    );
    const deleted = fakeGitHub({ "GET /repos/acme/app/installation": { status: 401, body: { message: "Bad credentials" } } });
    await expect(new GitHubAppClient(deleted.fetcher).submitReview(app, "https://github.com/acme/app/pull/3", { commitId: "c".repeat(40), event: "comment", body: "", comments: [] })).rejects.toThrow(
      "GitHub didn't accept the reviewer app's key.",
    );
    await expect(
      new GitHubAppClient(missing.fetcher).submitReview(app, "https://github.example.com/acme/app/pull/3", { commitId: "c".repeat(40), event: "comment", body: "", comments: [] }),
    ).rejects.toThrow("The reviewer app works with repositories on github.com.");
  });
});

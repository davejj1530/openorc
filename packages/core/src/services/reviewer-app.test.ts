import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "@openorc/db";
import { GitHubAppClient, type ReviewSubmission } from "@openorc/git";
import { ReviewerAppService, reviewerAppName } from "./reviewer-app.js";

/** A plain GET that can send any Host header, as a browser or a rebinding page would. */
function get(target: string, host?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "GET", headers: { host: host ?? url.host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

const created = { id: 42, slug: "ada-reviewer", name: "ada reviewer", owner: { login: "ada" }, pem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n" };
const services: ReviewerAppService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.shutdown();
});

function setup(options: { exchange?: () => Response | Promise<Response>; secrets?: boolean } = {}) {
  const saved: string[] = [];
  const secrets = { load: async () => saved.at(-1) ?? null, save: async (value: string) => void saved.push(value) };
  const fetcher = vi.fn(async () => (await options.exchange?.()) ?? new Response(JSON.stringify(created), { status: 201 })) as unknown as typeof fetch;
  const invalidate = vi.fn();
  const service = new ReviewerAppService(Db.memory(), {
    ...(options.secrets === false ? {} : { secrets }),
    github: new GitHubAppClient(fetcher),
    login: async () => "ada",
    invalidate,
  });
  services.push(service);
  return { service, saved, fetcher, invalidate };
}

describe("reviewer app setup", () => {
  it("names the app after the account, within GitHub's limit", () => {
    expect(reviewerAppName("ada")).toBe("ada reviewer");
    expect(reviewerAppName("a".repeat(39)).length).toBeLessThanOrEqual(34);
    expect(reviewerAppName(null)).toMatch(/^OpenOrc reviewer [0-9a-f]{4}$/);
  });

  it("serves a page that sends GitHub the app to create, only to its own link", async () => {
    const { service, invalidate } = setup();
    const { url } = await service.setup();
    expect(service.status().setupUrl).toBe(url);
    expect(invalidate).toHaveBeenCalledWith(["reviewer-app"]);
    const page = await get(url);
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("form-action https://github.com");
    const state = new URL(url).searchParams.get("state")!;
    expect(page.body).toContain(`action="https://github.com/settings/apps/new?state=${state}"`);
    const manifest = JSON.parse(/name="manifest" value="([^"]*)"/.exec(page.body)![1]!.replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "ada reviewer", redirect_url: `${new URL(url).origin}/reviewer-app/created`, default_permissions: { pull_requests: "write" } });
    expect((await get(url.replace(state, "guess"))).status).toBe(403);
    expect((await get(url, "evil.example")).status).toBe(404);
  });

  it("keeps the app's key once GitHub sends the browser back, then asks where to install it", async () => {
    const { service, saved, fetcher } = setup();
    const { url } = await service.setup();
    const state = new URL(url).searchParams.get("state")!;
    const back = await get(`${new URL(url).origin}/reviewer-app/created?code=abc&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe("https://github.com/apps/ada-reviewer/installations/new");
    expect(vi.mocked(fetcher).mock.calls[0]![0]).toBe("https://api.github.com/app-manifests/abc/conversions");
    expect(saved).toEqual([created.pem]);
    expect(service.status()).toEqual({
      app: { name: "ada reviewer", slug: "ada-reviewer", owner: "ada", login: "ada-reviewer[bot]", installUrl: "https://github.com/apps/ada-reviewer/installations/new", allowApprove: false },
      setupUrl: null,
      error: null,
    });
    // The page served its purpose and is gone.
    await vi.waitFor(async () => expect(await get(url).catch(() => "closed")).toBe("closed"));
  });

  it("reports a failed exchange and lets setup start over", async () => {
    const { service, saved } = setup({ exchange: () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) });
    const { url } = await service.setup();
    const state = new URL(url).searchParams.get("state")!;
    const back = await get(`${new URL(url).origin}/reviewer-app/created?code=stale&state=${state}`);
    expect(back.status).toBe(500);
    expect(back.body).toContain("Return to OpenOrc and try again.");
    expect(saved).toEqual([]);
    expect(service.status()).toMatchObject({ app: null, setupUrl: null, error: expect.stringContaining("GitHub couldn't finish creating the app") });
  });

  it("needs protected storage for the key", async () => {
    const { service } = setup({ secrets: false });
    await expect(service.setup()).rejects.toThrow("Protected storage is unavailable");
  });

  it("stops waiting when setup is cancelled", async () => {
    const { service } = setup();
    const { url } = await service.setup();
    service.cancel();
    expect(service.status().setupUrl).toBeNull();
    await vi.waitFor(async () => expect(await get(url).catch(() => "closed")).toBe("closed"));
  });

  it("can still be cancelled while GitHub trades the code, and then keeps nothing", async () => {
    let answer!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => (answer = resolve));
    const { service, saved, fetcher } = setup({ exchange: () => exchange });
    const { url } = await service.setup();
    const back = `${new URL(url).origin}/reviewer-app/created?code=abc&state=${new URL(url).searchParams.get("state")}`;
    const finishing = get(back);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(service.status().setupUrl).toBe(url);
    // The code is traded once, however often the browser comes back.
    expect((await get(back)).status).toBe(403);
    service.cancel();
    answer(new Response(JSON.stringify(created), { status: 201 }));
    const page = await finishing;
    expect(page.status).toBe(409);
    expect(page.body).toContain('href="https://github.com/settings/apps/ada-reviewer"');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
    expect(service.status()).toEqual({ app: null, setupUrl: null, error: null });
  });
});

describe("posting as the reviewer app", () => {
  const review: ReviewSubmission = { commitId: "c".repeat(40), event: "approve", body: "Review by Claude Opus 5.5.", comments: [] };

  async function ready() {
    const context = setup();
    const { url } = await context.service.setup();
    await get(`${new URL(url).origin}/reviewer-app/created?code=abc&state=${new URL(url).searchParams.get("state")}`);
    return context;
  }

  it("approves only once the user allows it", async () => {
    const { service } = await ready();
    const submit = vi.spyOn(GitHubAppClient.prototype, "submitReview").mockResolvedValue({ url: "https://github.com/acme/app/pull/3#pullrequestreview-1" });
    await expect(service.submitReview("https://github.com/acme/app/pull/3", review)).rejects.toThrow("Your reviewer app isn't allowed to approve.");
    await service.submitReview("https://github.com/acme/app/pull/3", { ...review, event: "request_changes" });
    service.configure(true);
    await service.submitReview("https://github.com/acme/app/pull/3", review);
    expect(submit.mock.calls.map(([app, , posted]) => [app.pem, posted.event])).toEqual([
      [created.pem, "request_changes"],
      [created.pem, "approve"],
    ]);
    submit.mockRestore();
  });

  it("forgets the app and its key on this device", async () => {
    const { service, saved } = await ready();
    await service.remove();
    expect(saved.at(-1)).toBe("");
    expect(service.status().app).toBeNull();
    await expect(service.submitReview("https://github.com/acme/app/pull/3", review)).rejects.toThrow("Set up a reviewer app in Settings first.");
  });
});

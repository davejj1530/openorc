import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPublishedReleases, publishedReleases } from "./changelog";

const release = (changes: Record<string, unknown> = {}) => ({
  tag_name: "v0.1.0",
  html_url: "https://github.com/davejj1530/openorc/releases/tag/v0.1.0",
  published_at: "2026-09-25T10:00:00Z",
  prerelease: false,
  draft: false,
  body: "## Highlights\n\n- First public release.\n",
  ...changes,
});

// node:test owns registered test completion and reports any rejection.
void test("shows only published releases and keeps beta releases distinct", () => {
  const entries = publishedReleases([
    release({ tag_name: "v0.2.0", html_url: "https://github.com/davejj1530/openorc/releases/tag/v0.2.0", draft: true, body: "## Highlights\n- Private plans" }),
    release(),
    release({
      tag_name: "v0.2.0-beta.1",
      html_url: "https://github.com/davejj1530/openorc/releases/tag/v0.2.0-beta.1",
      published_at: "2026-09-26T10:00:00Z",
      prerelease: true,
      body: "## What's new\n- **Faster** launches.\n\n## Install notes\n- Internal detail",
    }),
    release({ tag_name: "v0.3.0", published_at: null }),
    release({ tag_name: "v0.4.0", html_url: "https://example.com/not-a-release" }),
  ]);

  assert.deepEqual(
    entries.map(({ tag, prerelease }) => ({ tag, prerelease })),
    [
      { tag: "v0.2.0-beta.1", prerelease: true },
      { tag: "v0.1.0", prerelease: false },
    ],
  );
  assert.deepEqual(entries[0]?.highlights, ["Faster launches."]);
  assert.deepEqual(entries[1]?.highlights, ["First public release."]);
});

void test("treats an anonymous 404 as no public releases", async () => {
  const entries = await loadPublishedReleases(async () => new Response(null, { status: 404 }));
  assert.deepEqual(entries, []);
});

void test("reads all release pages before sorting the changelog", async () => {
  const calls: string[] = [];
  const entries = await loadPublishedReleases(async (input) => {
    calls.push(String(input));
    return calls.length === 1
      ? Response.json([release()], { headers: { link: '<https://api.github.com/repos/davejj1530/openorc/releases?per_page=100&page=2>; rel="next"' } })
      : Response.json([release({ tag_name: "v0.2.0", html_url: "https://github.com/davejj1530/openorc/releases/tag/v0.2.0", published_at: "2026-09-26T10:00:00Z" })]);
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.tag),
    ["v0.2.0", "v0.1.0"],
  );
});

void test("fails the build when GitHub returns an unexpected response", async () => {
  await assert.rejects(
    loadPublishedReleases(async () => new Response(null, { status: 503 })),
    /GitHub releases request failed: 503/,
  );
  assert.throws(() => publishedReleases({ message: "not a list" }), /invalid releases list/);
});

void test("development pages render without requesting GitHub releases", { timeout: 30_000 }, async (t) => {
  const { dev } = await import("astro");
  const cacheDir = await mkdtemp(join(tmpdir(), "openorc-website-test-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const fetchPage = globalThis.fetch;
  let releaseRequests = 0;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.github.com/")) {
      releaseRequests++;
      return Promise.resolve(new Response(null, { status: 403, statusText: "rate limit exceeded" }));
    }
    return fetchPage(input, init);
  });

  const server = await dev({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    cacheDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  t.after(() => server.stop());

  for (const path of ["/", "/docs/", "/changelog/", "/"]) {
    const response = await fetchPage(`http://127.0.0.1:${server.address.port}${path}`);
    const html = await response.text();
    assert.equal(releaseRequests, 0, `${path} must not contact GitHub in development`);
    assert.equal(response.status, 200);
    assert.match(html, /id="main"/);
    assert.doesNotMatch(html, /GitHub releases request failed/);
  }
});

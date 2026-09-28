const releasesUrl = "https://api.github.com/repos/davejj1530/openorc/releases?per_page=100";
const releasePath = "/davejj1530/openorc/releases/tag/";

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
}

export interface ChangelogRelease {
  tag: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
  highlights: string[];
}

function releaseHighlights(body: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^#{1,3}\s+(?:highlights|what(?:'|’)s new)\s*$/i.test(line.trim()));
  if (start < 0) return [];

  const highlights: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/.test(line)) break;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/(?<!\w)[*_`]+|[*_`]+(?!\w)/g, "")
      .trim();
    if (text) highlights.push(text);
    if (highlights.length === 5) break;
  }
  return highlights;
}

export function publishedReleases(input: unknown): ChangelogRelease[] {
  if (!Array.isArray(input)) throw new Error("GitHub returned an invalid releases list.");

  return input
    .flatMap((value: GitHubRelease) => {
      if (value?.draft !== false || typeof value.published_at !== "string" || Number.isNaN(Date.parse(value.published_at))) return [];
      if (typeof value.tag_name !== "string" || typeof value.html_url !== "string") return [];
      let url: URL;
      try {
        url = new URL(value.html_url);
      } catch {
        return [];
      }
      if (url.origin !== "https://github.com" || !url.pathname.startsWith(releasePath)) return [];

      return [
        {
          tag: value.tag_name,
          url: url.href,
          publishedAt: value.published_at,
          prerelease: value.prerelease === true,
          highlights: releaseHighlights(typeof value.body === "string" ? value.body : ""),
        },
      ];
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

export async function loadPublishedReleases(fetcher: typeof fetch = fetch, token?: string): Promise<ChangelogRelease[]> {
  const releases: unknown[] = [];
  let nextUrl: string | null = releasesUrl;
  while (nextUrl) {
    const response: Response = await fetcher(nextUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "openorc-website", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    // The repository is private before launch. Anonymous visitors cannot see its releases.
    if (response.status === 404 && !token && releases.length === 0) return [];
    if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status} ${response.statusText}`);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error("GitHub returned an invalid releases list.");
    releases.push(...page);

    const next: string | null = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    if (next && !next.startsWith(releasesUrl.split("?")[0] + "?")) throw new Error("GitHub returned an invalid next page URL.");
    nextUrl = next;
  }
  return publishedReleases(releases);
}

let cachedReleases: Promise<ChangelogRelease[]> | undefined;

export function getPublishedReleases(): Promise<ChangelogRelease[]> {
  // Development renders pages on demand; only the static build needs live releases.
  if (import.meta.env.DEV) return Promise.resolve([]);
  return (cachedReleases ??= loadPublishedReleases(fetch, process.env.GITHUB_TOKEN));
}

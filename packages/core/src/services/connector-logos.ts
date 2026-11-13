import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** The most a connector's image may weigh. */
export const LOGO_BYTES = 64 * 1024;
const PAGE_BYTES = 512 * 1024;
const REDIRECTS = 3;
/** How long a look the web did not answer waits before it is tried again. */
const RETRY_MS = 5 * 60_000;
/** Sites answer a browser's request; some turn away a bare script. */
const USER_AGENT = "Mozilla/5.0 (compatible; OpenOrc)";

/** The network as logo lookups see it. */
export interface LogoWeb {
  fetch(url: URL, init: RequestInit): Promise<Response>;
  /** Every address a host name resolves to. */
  resolve(host: string): Promise<string[]>;
  /** How long one request may take, its body included. */
  timeoutMs: number;
}

const theWeb: LogoWeb = {
  fetch: (url, init) => fetch(url, init),
  resolve: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
  timeoutMs: 4000,
};

export type LogoSource = { site: string } | { icon: string };

/** The body, or null once it runs past `limit` bytes, which stops reading there. */
export async function boundedBody(answer: Response, limit: number): Promise<Buffer | null> {
  const reader = answer.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** The first `limit` bytes of a body: a page's icons sit in its head, near the start of even a long page. */
async function leadingText(answer: Response, limit: number): Promise<string> {
  const reader = answer.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done && size < limit; next = await reader.read()) {
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

/** Lets an answer go unread; an unread body holds its connection until the timeout. */
function discard(answer: Response): null {
  void answer.body?.cancel().catch(() => undefined);
  return null;
}

/**
 * Connectors whose servers keep their address to themselves, by the name people know them by: the maker's site, or an
 * image where the site would only show a sign-in page.
 */
const KNOWN: Record<string, LogoSource> = {
  gmail: { icon: "https://ssl.gstatic.com/images/branding/product/2x/gmail_2020q4_32dp.png" },
  googlecalendar: { icon: "https://ssl.gstatic.com/images/branding/product/2x/calendar_2020q4_32dp.png" },
  googledrive: { icon: "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_32dp.png" },
  claudedocs: { icon: "https://claude.ai/images/claude_app_icon.png" },
  figma: { site: "figma.com" },
  github: { site: "github.com" },
  gitlab: { site: "gitlab.com" },
  linear: { site: "linear.app" },
  notion: { site: "notion.so" },
  slack: { site: "slack.com" },
  sentry: { site: "sentry.io" },
  vercel: { site: "vercel.com" },
  stripe: { site: "stripe.com" },
  supabase: { site: "supabase.com" },
  cloudflare: { site: "cloudflare.com" },
  atlassian: { site: "atlassian.com" },
  jira: { site: "atlassian.com" },
  confluence: { site: "atlassian.com" },
  asana: { site: "asana.com" },
  hubspot: { site: "hubspot.com" },
  intercom: { site: "intercom.com" },
  airtable: { site: "airtable.com" },
  canva: { site: "canva.com" },
  zapier: { site: "zapier.com" },
  playwright: { site: "playwright.dev" },
  posthog: { site: "posthog.com" },
  netlify: { site: "netlify.com" },
  huggingface: { site: "huggingface.co" },
  context7: { site: "context7.com" },
  neon: { site: "neon.tech" },
  mobbin: { site: "mobbin.com" },
  paper: { site: "paper.design" },
  rive: { site: "rive.app" },
  higgsfield: { site: "higgsfield.ai" },
};

/** Subdomains a server's address carries that its maker's site does not: `mcp.linear.app` is linear.app's. */
const SERVICE_LABELS = new Set(["mcp", "api", "www", "app", "server", "remote", "gateway"]);

/** Names that only mean something on this Mac or the network it sits on. */
const PRIVATE_NAMES = /(^|\.)(localhost|localdomain|local|internal|intranet|private|corp|lan|home|arpa|test|invalid|example|onion|alt)$/;

/** Addresses off the public web: this Mac, private and shared networks, link-local, documentation and reserved ranges. */
const PRIVATE_ADDRESSES = new BlockList();
for (const range of [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "::/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
]) {
  const [network = "", bits] = range.split("/");
  PRIVATE_ADDRESSES.addSubnet(network, Number(bits), isIP(network) === 6 ? "ipv6" : "ipv4");
}

/** An address on the public web. IPv4 rules also cover IPv4-mapped IPv6 addresses. */
function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !PRIVATE_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** A host name on the public web by its name alone; where it resolves to is checked when it is asked. */
function publicHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, "");
  if (!name.includes(".") || name.startsWith("[") || isIP(name)) return false;
  return !PRIVATE_NAMES.test(name);
}

/** The maker's site for a server's host, dropping service labels while a name and its domain remain. */
function makerSite(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.+$/, "").split(".");
  while (labels.length > 2 && SERVICE_LABELS.has(labels[0]!)) labels.shift();
  const site = labels.join(".");
  return publicHost(site) ? site : null;
}

/** Where a connector's image may be found when its server sends none: its own address's site, else a known name's. */
export function logoSource(title: string, sites: readonly string[]): LogoSource | null {
  for (const host of sites) {
    const site = makerSite(host);
    if (site) return { site };
  }
  return KNOWN[title.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null;
}

/** An https address on the public web, the only kind an image is asked of. */
function safeAddress(address: string, base?: string): URL | null {
  try {
    const url = new URL(address, base);
    return url.protocol === "https:" && publicHost(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Asks an address once every address its host resolves to is on the public web; null when one is not. A name can
 * resolve differently by the time the request connects, a window this narrows but does not close.
 */
async function ask(web: LogoWeb, url: URL): Promise<Response | null> {
  const addresses = await web.resolve(url.hostname);
  if (!addresses.length || !addresses.every(publicAddress)) return null;
  return web.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(web.timeoutMs), headers: { "user-agent": USER_AGENT } });
}

/** Asks for an address, following up to three redirects that stay on the public web. Throws when the web does not answer. */
async function follow(web: LogoWeb, address: URL): Promise<Response | null> {
  let url = address;
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    const answer = await ask(web, url);
    if (!answer || answer.ok) return answer;
    discard(answer);
    const next = answer.status >= 300 && answer.status < 400 ? safeAddress(answer.headers.get("location") ?? "", url.href) : null;
    if (!next) return null;
    url = next;
  }
  return null;
}

/** An image as a data URL, or null when the answer is not one or weighs too much. Throws when the web does not answer. */
async function imageAt(web: LogoWeb, address: URL): Promise<string | null> {
  const answer = await follow(web, address);
  if (!answer) return null;
  const type = answer.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!/^image\/[a-z0-9.+-]+$/i.test(type) || Number(answer.headers.get("content-length") ?? 0) > LOGO_BYTES) return discard(answer);
  const bytes = await boundedBody(answer, LOGO_BYTES);
  return bytes?.length ? `data:${type};base64,${bytes.toString("base64")}` : null;
}

/** The image at an address a server names for itself, asked only of the public web. */
export async function iconImage(address: string, web: LogoWeb = theWeb): Promise<string | null> {
  const url = safeAddress(address);
  return url ? imageAt(web, url) : null;
}

/** An attribute of one tag, unquoted or in either quotes. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/**
 * The page's icons, best first: a drawing, then the largest picture, then the home-screen icon, which sits on a tile of
 * its own and reads less like the mark.
 */
export function pageIcons(html: string): string[] {
  const ranked = [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
    const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
    const href = attribute(tag, "href");
    if (!href || !/\b(icon|apple-touch-icon)\b/.test(rel) || /\bmask-icon\b/.test(rel)) return [];
    const drawing = attribute(tag, "type") === "image/svg+xml" || /\.svg(\?|$)/i.test(href);
    const sizes = (attribute(tag, "sizes") ?? "").match(/\d+/);
    const size = sizes ? Number(sizes[0]) : 16;
    const touch = rel.includes("apple-touch-icon") ? 100 : size;
    const score = drawing ? 1000 : touch;
    return [{ href, score }];
  });
  return ranked.sort((a, b) => b.score - a.score).map((icon) => icon.href);
}

/** A home page's text when it is a web page. */
function pageText(page: Response): Promise<string> {
  if (/html/i.test(page.headers.get("content-type") ?? "")) return leadingText(page, PAGE_BYTES);
  discard(page);
  return Promise.resolve("");
}

/**
 * The image a site shows for itself: what its home page names, else its favicon. Null only when the site answered
 * every request without one; when a request went unanswered and nothing was found, throws, so the look can be retried.
 */
async function siteImage(web: LogoWeb, site: string): Promise<string | null> {
  const failures: unknown[] = [];
  const settle = <T>(work: Promise<T>, otherwise: T): Promise<T> =>
    work.catch((error: unknown) => {
      failures.push(error);
      return otherwise;
    });
  const home = new URL(`https://${site}/`);
  const page = await settle(follow(web, home), null);
  const html = page ? await settle(pageText(page), "") : "";
  const base = page?.url || home.href;
  for (const href of pageIcons(html).slice(0, 3)) {
    const address = safeAddress(href, base);
    const image = address ? await settle(imageAt(web, address), null) : null;
    if (image) return image;
  }
  const favicon = await settle(imageAt(web, new URL("/favicon.ico", home)), null);
  if (favicon || !failures.length) return favicon;
  throw failures[0];
}

/**
 * Images found for connectors from their makers' sites. What a site answered is kept while the app runs; a look the
 * web did not answer, as when the app starts offline, is tried again after a while.
 */
export class SiteLogos {
  private readonly found = new Map<string, string | null>();
  private readonly failedAt = new Map<string, number>();
  private readonly looking = new Map<string, Promise<void>>();

  constructor(private readonly web: LogoWeb = theWeb) {}

  /** The image for a source, once found. */
  get(source: LogoSource | null): string | null {
    return source ? (this.found.get(keyOf(source)) ?? null) : null;
  }

  /** Shares pending lookups and reports each image as it arrives; resolves true if any lookup found an image. */
  async look(sources: readonly LogoSource[], onFound?: () => void): Promise<boolean> {
    const due = new Map(sources.filter((source) => this.looking.has(keyOf(source)) || this.due(keyOf(source))).map((source) => [keyOf(source), source]));
    await Promise.all(
      [...due].map(async ([key, source]) => {
        let pending = this.looking.get(key);
        if (!pending) {
          pending = this.lookFor(key, source);
          this.looking.set(key, pending);
        }
        await pending;
        if (this.found.get(key)) onFound?.();
      }),
    );
    return [...due.keys()].some((key) => this.found.get(key));
  }

  private due(key: string): boolean {
    const failed = this.failedAt.get(key);
    return !this.found.has(key) && !this.looking.has(key) && (failed === undefined || Date.now() - failed >= RETRY_MS);
  }

  private async lookFor(key: string, source: LogoSource): Promise<void> {
    try {
      this.found.set(key, "site" in source ? await siteImage(this.web, source.site) : await iconImage(source.icon, this.web));
      this.failedAt.delete(key);
    } catch {
      this.failedAt.set(key, Date.now());
    } finally {
      this.looking.delete(key);
    }
  }
}

const keyOf = (source: LogoSource) => ("site" in source ? `site:${source.site}` : `icon:${source.icon}`);

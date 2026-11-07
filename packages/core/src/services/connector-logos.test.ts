import { afterEach, expect, it, vi } from "vitest";
import { LOGO_BYTES, logoSource, pageIcons, SiteLogos, type LogoSource, type LogoWeb } from "./connector-logos.js";

const PUBLIC = "93.184.216.34";
const PNG = new Uint8Array([137, 80, 78, 71]);
const PNG_DATA = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

type Route = { status?: number; headers?: Record<string, string>; body?: string | Uint8Array } | ((init: RequestInit) => Promise<Response>);

/** The web as a test gives it: an answer per address, where each host resolves, every address asked and every body let go unread. */
function fakeWeb(routes: Record<string, Route>, addresses: Record<string, string[]> = {}) {
  const asked: string[] = [];
  const released: string[] = [];
  const web: LogoWeb = {
    timeoutMs: 20,
    resolve: async (host) => addresses[host] ?? [PUBLIC],
    fetch: async (url, init) => {
      asked.push(url.href);
      const route = routes[url.href] ?? { status: 404 };
      if (typeof route === "function") return route(init);
      const bytes = typeof route.body === "string" ? new TextEncoder().encode(route.body) : (route.body ?? new Uint8Array());
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            controller.enqueue(bytes);
            controller.close();
          },
          cancel: () => void released.push(url.href),
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: route.status ?? 200, headers: route.headers });
    },
  };
  return { web, asked, released };
}

const png: Route = { headers: { "content-type": "image/png" }, body: PNG };

afterEach(() => {
  vi.useRealTimers();
});

it("finds a server's maker from its address, past service labels, and never on this Mac or its network", () => {
  expect(logoSource("linear", ["mcp.linear.app"])).toEqual({ site: "linear.app" });
  expect(logoSource("acme", ["api.acme.dev."])).toEqual({ site: "acme.dev" });
  expect(logoSource("docs", ["docs.example.org"])).toEqual({ site: "docs.example.org" });
  for (const host of ["127.0.0.1", "mcp.localhost", "localhost.", "nas.local", "printer.home.arpa", "wiki.corp", "tools.internal"]) expect(logoSource("tool", [host])).toBeNull();
});

it("knows the makers of servers that keep their address to themselves, by the name people use", () => {
  expect(logoSource("Google Calendar", [])).toEqual({ icon: "https://ssl.gstatic.com/images/branding/product/2x/calendar_2020q4_32dp.png" });
  expect(logoSource("vercel", [])).toEqual({ site: "vercel.com" });
  expect(logoSource("codegraph", [])).toBeNull();
});

it("ranks a page's icons: a drawing, then the largest picture, then the home-screen icon, never the mask", () => {
  const html = `<head>
    <link rel="mask-icon" href="/mask.svg">
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel='icon' href=/small.png sizes="16x16">
    <link rel="icon" href="/big.png" sizes="192x192">
    <link href="/mark.svg" rel="icon" type="image/svg+xml">
    <link rel="stylesheet" href="/site.css">
  </head>`;
  expect(pageIcons(html)).toEqual(["/mark.svg", "/big.png", "/touch.png", "/small.png"]);
});

it("finds a site's image from the icons its home page names", async () => {
  const { web } = fakeWeb({
    "https://acme.dev/": { headers: { "content-type": "text/html" }, body: `<head><link rel="icon" href="/mark.png"></head>` },
    "https://acme.dev/mark.png": png,
  });
  const logos = new SiteLogos(web);
  expect(await logos.look([{ site: "acme.dev" }])).toBe(true);
  expect(logos.get({ site: "acme.dev" })).toBe(PNG_DATA);
});

it("follows redirects only while they stay on the public web, letting each redirect's body go", async () => {
  const redirects = {
    "https://acme.dev/logo.png": "https://cdn.acme.dev/logo.png",
    "https://lan.acme.dev/logo.png": "https://192.168.1.2/logo.png",
    "https://dot.acme.dev/logo.png": "https://localhost./logo.png",
    "https://plain.acme.dev/logo.png": "http://acme.dev/logo.png",
    "https://rebind.acme.dev/logo.png": "https://wiki.acme.dev/logo.png",
  };
  const { web, asked, released } = fakeWeb(
    { ...Object.fromEntries(Object.entries(redirects).map(([from, to]) => [from, { status: 302, headers: { location: to } }])), "https://cdn.acme.dev/logo.png": png },
    { "wiki.acme.dev": ["127.0.0.1"] },
  );
  const logos = new SiteLogos(web);
  await logos.look(Object.keys(redirects).map((icon) => ({ icon })));
  expect(Object.keys(redirects).map((icon) => logos.get({ icon }))).toEqual([PNG_DATA, null, null, null, null]);
  expect(asked.sort()).toEqual([...Object.keys(redirects), "https://cdn.acme.dev/logo.png"].sort());
  expect(released.sort()).toEqual(Object.keys(redirects).sort());
});

it("asks nothing of a host that resolves off the public web", async () => {
  const hosts: Record<string, string[]> = {
    "private.acme.dev": ["10.0.0.7"],
    "mixed.acme.dev": [PUBLIC, "100.64.0.1"],
    "metadata.acme.dev": ["169.254.169.254"],
    "loopback.acme.dev": ["::1"],
    "mapped.acme.dev": ["::ffff:127.0.0.1"],
    "mapped-hex.acme.dev": ["::ffff:c0a8:102"],
    "unique.acme.dev": ["fd00::1"],
    "link.acme.dev": ["fe80::1"],
    "nothing.acme.dev": [],
  };
  const { web, asked } = fakeWeb({ "https://public.acme.dev/logo.png": png }, { ...hosts, "public.acme.dev": ["2606:4700::1"] });
  const logos = new SiteLogos(web);
  expect(await logos.look(Object.keys(hosts).map((host) => ({ icon: `https://${host}/logo.png` })))).toBe(false);
  expect(asked).toEqual([]);
  expect(await logos.look([{ icon: "https://public.acme.dev/logo.png" }])).toBe(true);
});

it("refuses an image past the size cap, reading no further than the cap", async () => {
  let read = 0;
  let stopped = false;
  const endless = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        read += 16 * 1024;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel: () => void (stopped = true),
    },
    { highWaterMark: 0 },
  );
  const sources: Record<string, Route> = {
    "https://acme.dev/fits.png": { headers: { "content-type": "image/png" }, body: new Uint8Array(LOGO_BYTES) },
    "https://acme.dev/big.png": { headers: { "content-type": "image/png" }, body: new Uint8Array(LOGO_BYTES + 1) },
    "https://acme.dev/said-big.png": { headers: { "content-type": "image/png", "content-length": String(LOGO_BYTES + 1) }, body: new Uint8Array(LOGO_BYTES + 1) },
    "https://acme.dev/endless.png": async () => new Response(endless, { headers: { "content-type": "image/png" } }),
  };
  const { web, released } = fakeWeb(sources);
  const logos = new SiteLogos(web);
  await logos.look(Object.keys(sources).map((icon) => ({ icon })));
  expect(Object.keys(sources).map((icon) => logos.get({ icon })?.slice(0, 22) ?? null)).toEqual(["data:image/png;base64,", null, null, null]);
  expect(released).toEqual(["https://acme.dev/said-big.png"]);
  expect(stopped).toBe(true);
  expect(read).toBeLessThanOrEqual(LOGO_BYTES + 16 * 1024);
});

it("refuses an answer that is not an image, or not a success, letting its body go", async () => {
  const sources: Record<string, Route> = {
    "https://acme.dev/page.png": { headers: { "content-type": "text/html" }, body: "<html></html>" },
    "https://acme.dev/gone.png": { status: 500, headers: { "content-type": "image/png" }, body: PNG },
  };
  const { web, released } = fakeWeb(sources);
  const logos = new SiteLogos(web);
  expect(await logos.look(Object.keys(sources).map((icon) => ({ icon })))).toBe(false);
  expect(released.sort()).toEqual(["https://acme.dev/gone.png", "https://acme.dev/page.png"]);
});

it("gives up on a request that hangs", async () => {
  const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const { web, asked } = fakeWeb({ "https://slow.acme.dev/logo.png": hang });
  const logos = new SiteLogos(web);
  expect(await logos.look([{ icon: "https://slow.acme.dev/logo.png" }])).toBe(false);
  expect(asked).toEqual(["https://slow.acme.dev/logo.png"]);
});

it("tries a look the web did not answer again after a while, but not a site that answered without an image", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let online = false;
  const { web, asked } = fakeWeb({
    "https://down.acme.dev/logo.png": async () => {
      if (!online) throw new TypeError("fetch failed");
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    },
    "https://plain.acme.dev/": { headers: { "content-type": "text/html" }, body: "<html><head></head></html>" },
  });
  const logos = new SiteLogos(web);
  const sources: LogoSource[] = [{ icon: "https://down.acme.dev/logo.png" }, { site: "plain.acme.dev" }];
  expect(await logos.look(sources)).toBe(false);
  expect(asked.sort()).toEqual(["https://down.acme.dev/logo.png", "https://plain.acme.dev/", "https://plain.acme.dev/favicon.ico"]);

  online = true;
  expect(await logos.look(sources)).toBe(false);
  expect(asked).toHaveLength(3);

  vi.setSystemTime(Date.now() + 5 * 60_000);
  expect(await logos.look(sources)).toBe(true);
  expect(asked.slice(3)).toEqual(["https://down.acme.dev/logo.png"]);
  expect(logos.get(sources[0]!)).toBe(PNG_DATA);
});

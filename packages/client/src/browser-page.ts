import { panelToolLabels } from "./panel-tools.js";
import { urlHost } from "./url-host.js";

/** Where a page is, as a tab or a line under a title names it: the host, with a port that is not the scheme's own. */
export function pageHost(url: string): string {
  return urlHost(url)?.host || url;
}

/** A Preview page's name: its title, else its host, else the tool's own name. */
export function pageLabel({ url, title }: { url: string; title: string }): string {
  return title || (url ? pageHost(url) : panelToolLabels.browser);
}

/** Names that only ever mean this machine or its own network. */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|ts\.net)$/;

function octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part <= 255) ? numbers : null;
}

/** Loopback, unspecified, private, link-local and the shared 100.64/10 range Tailscale hands out. */
function localIPv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
}

/** Loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10), or a mapped IPv4 address that is local. */
function localIPv6(address: string): boolean {
  if (address === "::1" || address === "::") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  if (mapped) return localIPv4(octets(mapped) ?? [0]);
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}

/**
 * Whether an address means the same page on a phone as on the Mac: http or https on a dotted public name or a public
 * address. A loopback, private or tailnet address on the phone is the phone, or a network it may not be on.
 */
export function publicAddress(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const hostname = urlHost(url)?.hostname;
  if (!hostname) return false;
  if (hostname.startsWith("[")) return !localIPv6(hostname.slice(1, -1));
  const ipv4 = octets(hostname);
  if (ipv4) return !localIPv4(ipv4);
  return hostname.includes(".") && !LOCAL_NAME.test(hostname.replace(/\.$/, ""));
}

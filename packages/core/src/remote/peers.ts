import { BlockList, isIPv4, isIPv6 } from "node:net";

// Addresses a phone on the same network or tailnet can come from. Anything else is dropped before a byte is read.
const reachable = new BlockList();
for (const [network, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  // Tailscale, and carrier-grade NAT.
  ["100.64.0.0", 10],
] as const)
  reachable.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::1", 128],
  ["fe80::", 10],
  // Unique local addresses, which hold Tailscale's fd7a:115c:a1e0::/48 too.
  ["fc00::", 7],
  ["fd7a:115c:a1e0::", 48],
] as const)
  reachable.addSubnet(network, prefix, "ipv6");

const MAPPED = "::ffff:";
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

/** A global IPv6 address shares its /64 only with hosts on the same link, such as a phone that dialed `<mac>.local`. */
function onLinkOf(address: string, own: readonly string[]): boolean {
  if (!globalUnicast.check(address, "ipv6")) return false;
  const links = new BlockList();
  for (const mine of own) if (isIPv6(mine)) links.addSubnet(mine, 64, "ipv6");
  return links.check(address, "ipv6");
}

/**
 * Whether a socket's source is loopback, private, link-local, unique local, on a tailnet, or a global IPv6 address
 * on one of the links the Mac is on. `own` is the Mac's interface addresses.
 */
export function isLocalPeer(address: string | undefined, own: readonly string[]): boolean {
  if (!address) return false;
  // A dual-stack listener sees IPv4 peers as IPv4-mapped IPv6 addresses.
  const unmapped = address.toLowerCase().startsWith(MAPPED) && isIPv4(address.slice(MAPPED.length)) ? address.slice(MAPPED.length) : address;
  try {
    if (isIPv4(unmapped)) return reachable.check(unmapped, "ipv4");
    return reachable.check(unmapped, "ipv6") || onLinkOf(unmapped, own);
  } catch {
    return false;
  }
}

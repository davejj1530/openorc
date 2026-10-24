import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import type { Route } from "@openorc/protocol";

/** How the Mac names itself and where a phone can reach it. Injected so tests never read real interfaces. */
export interface MachineProbe {
  name(): string;
  /** The `.local` name, then private IPv4 addresses. */
  lanHosts(): string[];
  /** The MagicDNS name and tailnet addresses; empty without Tailscale. Never rejects. */
  tailnetHosts(): Promise<string[]>;
}

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TAILNET_V4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const PRIVATE_V4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const TAILNET_CACHE_MS = 30_000;

const hostName = () => os.hostname().replace(/\.local$/i, "");

function ipv4Addresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((addresses) => (addresses ?? []).filter((address) => address.family === "IPv4" && !address.internal).map((address) => address.address));
}

interface TailscaleStatus {
  Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
}

/** `tailscale status --json` from the app's own CLI or one on PATH; null when there is none or it does not answer. */
function tailscaleStatus(): Promise<TailscaleStatus | null> {
  const binary = existsSync(TAILSCALE_APP) ? TAILSCALE_APP : "tailscale";
  return new Promise((resolve) => {
    execFile(binary, ["status", "--json"], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as TailscaleStatus);
      } catch {
        resolve(null);
      }
    });
  });
}

async function tailnetHosts(): Promise<string[]> {
  const fromInterfaces = ipv4Addresses().filter((address) => TAILNET_V4.test(address));
  const self = (await tailscaleStatus())?.Self;
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
  const addresses = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === "string" && TAILNET_V4.test(ip)) : [];
  return [...new Set([dnsName, ...addresses, ...fromInterfaces].filter(Boolean))];
}

export function machineProbe(): MachineProbe {
  let tailnet: { at: number; hosts: Promise<string[]> } | null = null;
  return {
    name: hostName,
    lanHosts: () => [`${hostName()}.local`, ...ipv4Addresses().filter((address) => PRIVATE_V4.test(address))],
    tailnetHosts() {
      if (!tailnet || Date.now() - tailnet.at > TAILNET_CACHE_MS) tailnet = { at: Date.now(), hosts: tailnetHosts() };
      return tailnet.hosts;
    },
  };
}

/** Same network first, then the tailnet, all on the listening port. */
export async function currentRoutes(machine: MachineProbe, port: number): Promise<Route[]> {
  const lan = machine.lanHosts().map((host): Route => ({ kind: "lan", host, port }));
  const tailnet = (await machine.tailnetHosts()).map((host): Route => ({ kind: "tailnet", host, port }));
  return [...lan, ...tailnet];
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443", ftp: "21" };

/**
 * Where an absolute URL points, read as `new URL()` reads a web address: `host` keeps a port that is not the scheme's
 * default, `hostname` never has one. Null when the text is not an absolute URL with a host. Parsed here because React
 * Native's URL only partly implements these fields.
 */
export function urlHost(url: string): { host: string; hostname: string } | null {
  const match = /^([a-z][a-z\d+.-]*):\/\/(?:[^\s/?#@]*@)?(\[[\da-f:.]+\]|[^\s#%/:<>?@[\\\]^|]+)(?::(\d*))?(?:[/?#]|$)/i.exec(url.trim());
  if (!match) return null;
  const hostname = match[2]!.toLowerCase();
  const port = match[3] ? String(Number(match[3])) : "";
  const shown = port && port !== DEFAULT_PORTS[match[1]!.toLowerCase()] ? `:${port}` : "";
  return { host: hostname + shown, hostname };
}

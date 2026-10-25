import { visualizationCsp } from "@openorc/client";
import { connect } from "node:net";
import { afterEach, expect, it } from "vitest";
import { McpAppSandbox, appContentSecurityPolicy, isolateSandboxFrames } from "./mcp-app-sandbox";

const hosts: McpAppSandbox[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});
it("serves a distinct proxy and app with enforced CSP and revocable ownership", async () => {
  const host = new McpAppSandbox();
  hosts.push(host);
  await host.start();
  const app = await host.register(1, { html: "<h1>External app</h1>", csp: { resourceDomains: ["https://mobbin.com"] } });
  const proxy = await fetch(app.url);
  expect(proxy.headers.get("content-security-policy")).toContain("frame-src 'self'");
  expect(await proxy.text()).toContain("event.source === view.contentWindow");
  const resource = await fetch(app.url.replace("/proxy", "/view"));
  expect(resource.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(resource.headers.get("content-security-policy")).toContain("connect-src 'none'");
  expect(resource.headers.get("content-security-policy")).toContain("https://mobbin.com");
  expect(resource.headers.get("permissions-policy")).toContain("camera=()");
  expect(await resource.text()).toBe("<h1>External app</h1>");
  host.release(2, app.id);
  expect((await fetch(app.url)).status).toBe(200);
  host.releaseOwner(1);
  expect((await fetch(app.url)).status).toBe(404);
});
it("sends every connection of the window through itself, which tunnels nothing, but those to hosts it must reach", async () => {
  const proxies: Electron.ProxyConfig[] = [];
  const session = { setProxy: async (config: Electron.ProxyConfig) => void proxies.push(config) };
  const host = new McpAppSandbox();
  hosts.push(host);
  await host.start({ session, direct: ["localhost:5173"] });
  const origin = new URL((await host.register(1, { html: "<p>Chart</p>", csp: {} })).url).origin;
  expect(proxies).toEqual([{ mode: "fixed_servers", proxyRules: origin, proxyBypassRules: `<-loopback>,${new URL(origin).host},localhost:5173` }]);
  const app = await host.register(1, { html: "<h1>App</h1>", csp: { resourceDomains: ["https://*.mobbin.com"], connectDomains: ["https://api.example.com:443"] } });
  expect(proxies.at(-1)?.proxyBypassRules).toBe(`<-loopback>,${new URL(origin).host},localhost:5173,https://*.mobbin.com,https://api.example.com:443`);
  host.release(1, app.id);
  expect(proxies.at(-1)?.proxyBypassRules).toBe(`<-loopback>,${new URL(origin).host},localhost:5173`);
  expect(proxies).toHaveLength(3);
  // As a proxy, it opens no tunnel and fetches nothing for anyone.
  const ask = (request: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(Number(new URL(origin).port), "127.0.0.1", () => socket.write(request));
      let reply = "";
      socket.on("data", (data) => (reply += data.toString()));
      socket.on("end", () => socket.end());
      socket.on("close", () => resolve(reply));
    });
  expect(await ask("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")).toBe("");
  expect(await ask("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n")).toMatch(/^HTTP\/1\.1 404/);
});
it.each([
  "*",
  "https:",
  "https://example.com; script-src *",
  "https://example.com/path",
  "http://example.com",
  "https://127.0.0.1",
  "https://localhost",
  "https://app.localhost",
  "https://x.local",
  "https://example.com\nX-Header: hi",
])("rejects unsafe CSP sources: %s", (domain) => {
  expect(() => appContentSecurityPolicy({ connectDomains: [domain] })).toThrow();
});
it("accepts declared HTTPS wildcard subdomains without enabling eval, workers or navigation", () => {
  const csp = appContentSecurityPolicy({ resourceDomains: ["https://*.example.com"], connectDomains: ["https://api.example.com:443"] });
  expect(csp).toContain("https://*.example.com");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toContain("worker-src 'none'");
});
it("holds a visualization to the policy its own document carries, which is all the phone has", () => {
  const header = appContentSecurityPolicy({})
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "sandbox allow-scripts");
  expect(header).toEqual(visualizationCsp.split("; "));
});
it("gives every sandboxed document a renderer of its own, keeping the features already switched on", () => {
  const switches = new Map([["enable-features", "PdfViewer"]]);
  const commandLine = { getSwitchValue: (name: string) => switches.get(name) ?? "", appendSwitch: (name: string, value?: string) => void switches.set(name, value ?? "") };
  isolateSandboxFrames(commandLine);
  expect(switches.get("enable-features")).toBe("PdfViewer,IsolateSandboxedIframes:grouping/per-document");
  switches.clear();
  isolateSandboxFrames(commandLine);
  expect(switches.get("enable-features")).toBe("IsolateSandboxedIframes:grouping/per-document");
});

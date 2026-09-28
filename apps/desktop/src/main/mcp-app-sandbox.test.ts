import { afterEach, expect, it } from "vitest";
import { McpAppSandbox, appContentSecurityPolicy } from "./mcp-app-sandbox";

const hosts: McpAppSandbox[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});
it("serves a distinct proxy and app with enforced CSP and revocable ownership", async () => {
  const host = new McpAppSandbox();
  hosts.push(host);
  await host.start();
  const app = host.register(1, { html: "<h1>External app</h1>", csp: { resourceDomains: ["https://mobbin.com"] } });
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

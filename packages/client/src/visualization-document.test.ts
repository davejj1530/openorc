import { expect, it } from "vitest";
import { visualizationContextScript, visualizationCsp, visualizationDocument, visualizationFrameHeight, type VisualizationContext } from "./visualization-document.js";

// This package has no DOM; the phone's tests run the page itself (apps/mobile/src/thread/visualization-page.test.ts).

const dark: VisualizationContext = {
  theme: "dark",
  font: '"Immaculate Gothic", system-ui',
  colors: { "--background": "#0a0a0a", "--foreground": "#ffffff", "--muted": "#b8b8b8", "--border": "#ffffff1c", "--accent": "#ffffff", "--surface": "#ffffff12" },
};

const head = (document: string) => document.slice(document.indexOf("<head>") + "<head>".length, document.indexOf("</head>"));

it.each(["frame", "react-native"] as const)("opens the %s page with its policy, before any style or script", (host) => {
  const document = visualizationDocument('<img src="https://example.com/a.png">', { host });
  expect(head(document).startsWith(`<meta http-equiv="Content-Security-Policy" content="${visualizationCsp}">`)).toBe(true);
});

it("refuses every load a policy governs: nothing but inline script and style, and images from data: and blob:", () => {
  const directives = new Map(visualizationCsp.split("; ").map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1)]));
  expect(directives.get("default-src")).toEqual(["'none'"]);
  expect(directives.get("connect-src")).toEqual(["'none'"]);
  expect(directives.get("script-src")).toEqual(["'unsafe-inline'"]);
  expect(directives.get("style-src")).toEqual(["'unsafe-inline'"]);
  expect(directives.get("img-src")).toEqual(["data:", "blob:"]);
  for (const name of ["frame-src", "form-action", "base-uri", "object-src", "worker-src"]) expect(directives.get(name)).toEqual(["'none'"]);
  expect(visualizationCsp).not.toMatch(/https?:|\*|'self'|unsafe-eval/);
});

it("posts through the bridge on the phone and to the parent frame on the desktop", () => {
  const phone = visualizationDocument("<p>x</p>", { host: "react-native" });
  const desktop = visualizationDocument("<p>x</p>");
  expect(phone).toContain("window.ReactNativeWebView.postMessage(JSON.stringify(message))");
  expect(phone).not.toContain("parent.postMessage");
  expect(desktop).toContain("parent.postMessage(message,'*',transfer)");
  expect(desktop).not.toContain("ReactNativeWebView");
});

it("hands the desktop's host a channel as the page comes up, and the phone, whose web view reports its end, none", () => {
  expect(visualizationDocument("<p>x</p>")).toContain("send('ui/notifications/initialized',{},(()=>{const channel=new MessageChannel();");
  expect(visualizationDocument("<p>x</p>", { host: "react-native" })).not.toContain("MessageChannel");
});

it("stops links on the phone's page only; the desktop's sandbox frame goes to its blocked page", () => {
  expect(visualizationDocument("<p>x</p>", { host: "react-native" })).toContain("event.preventDefault()");
  expect(visualizationDocument("<p>x</p>")).not.toContain("preventDefault");
});

it("starts the page's text at the host's text scale when it sends one", () => {
  expect(visualizationDocument("<p>x</p>", { host: "react-native", context: { ...dark, textScale: 1.35 } })).toContain(';-webkit-text-size-adjust:135%">');
  expect(visualizationDocument("<p>x</p>", { host: "react-native", context: dark })).not.toContain("text-size-adjust:");
});

it("leaves the desktop's page in its defaults until the context message, as before", () => {
  const desktop = visualizationDocument("<p>x</p>");
  expect(desktop).toContain("<html><head>");
  expect(desktop).toContain("<body><main><p>x</p></main></body>");
});

it("writes a starting theme into the page's root and body, escaped so it cannot leave its attributes", () => {
  const document = visualizationDocument("<p>x</p>", { host: "react-native", context: { ...dark, font: 'x" onload="alert(1)" <b>' } });
  expect(document).toContain('<html data-theme="dark" style="color-scheme:dark;--background:#0a0a0a;--foreground:#ffffff;--muted:#b8b8b8;--border:#ffffff1c;--accent:#ffffff;--surface:#ffffff12">');
  expect(document).toContain('<body style="font-family:x&quot; onload=&quot;alert(1)&quot; &lt;b>">');
});

it("hands a top-level page the context as a message from its parent, which at the top is the page itself", () => {
  const script = visualizationContextScript(dark);
  expect(script).toBe(`window.dispatchEvent(new MessageEvent('message',{source:window,data:${JSON.stringify({ jsonrpc: "2.0", method: "openorc/visualization-context", params: dark })}}));true;`);
});

it.each([
  [40, 120],
  [480, 480],
  [5000, 1200],
])("draws a page that says it is %i tall at %i", (height, drawn) => {
  expect(visualizationFrameHeight(height)).toBe(drawn);
});

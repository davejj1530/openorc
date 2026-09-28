import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { appOrigin, isExternalWebUrl, permitted } from "./app-origin";

const rendererDir = path.join(path.sep, "Applications", "OpenOrc.app", "Contents", "Resources", "app.asar", "out", "renderer");
const page = pathToFileURL(path.join(rendererDir, "index.html")).href;

describe("appOrigin", () => {
  it("accepts only the packaged renderer's files in a packaged app", () => {
    const isApp = appOrigin({ packaged: true, devUrl: "http://localhost:5173", rendererDir });
    expect(isApp(page)).toBe(true);
    expect(isApp("openorc-asset://attachments/a.png")).toBe(true);
    expect(isApp(pathToFileURL("/etc/passwd").href)).toBe(false);
    expect(isApp(pathToFileURL(`${rendererDir}-evil/index.html`).href)).toBe(false);
    // A development server is never trusted by a packaged app, even when the variable is set.
    expect(isApp("http://localhost:5173/")).toBe(false);
  });

  it("accepts the dev server by exact origin in development", () => {
    const isApp = appOrigin({ packaged: false, devUrl: "http://localhost:5173", rendererDir });
    expect(isApp("http://localhost:5173/#/threads")).toBe(true);
    expect(isApp("http://localhost:5173.evil.com/")).toBe(false);
    expect(isApp("http://localhost:5174/")).toBe(false);
  });
});

describe("permissions and external links", () => {
  const isApp = appOrigin({ packaged: true, devUrl: undefined, rendererDir });
  it("grants the app window notifications and clipboard writes, and nothing else", () => {
    expect(permitted("notifications", page, isApp)).toBe(true);
    expect(permitted("clipboard-sanitized-write", page, isApp)).toBe(true);
    expect(permitted("media", page, isApp)).toBe(false);
    expect(permitted("notifications", "http://127.0.0.1:4000/app", isApp)).toBe(false);
  });

  it("opens only web pages in the system browser", () => {
    expect(isExternalWebUrl("https://github.com/openorc")).toBe(true);
    expect(isExternalWebUrl("file:///Applications/Calculator.app")).toBe(false);
    expect(isExternalWebUrl("smb://server/share")).toBe(false);
    expect(isExternalWebUrl(42)).toBe(false);
  });
});

import { shell } from "electron";
import { isExternalWebUrl } from "./app-origin";

/**
 * Opens a web page in the person's browser when the core asks, as a GitHub sign-in the core waits on needs. Only main
 * reaches Electron's shell; the core asks over its private utility channel, never a renderer, and only for http and
 * https pages.
 */
export function installOpenBrowser(child: { on(event: "message", listener: (message: unknown) => void): unknown }, open: (url: string) => Promise<void> = (url) => shell.openExternal(url)): void {
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; url?: unknown };
    if (request.type === "open-browser" && isExternalWebUrl(request.url)) void open(request.url).catch(() => undefined);
  });
}

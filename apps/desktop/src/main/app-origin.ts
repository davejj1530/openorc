import { pathToFileURL } from "node:url";

/**
 * Where the app's own UI is allowed to live: the dev server in a development build, and otherwise only the files of
 * the packaged renderer. Any other file on disk, and any other page, is outside the app.
 */
export function appOrigin(options: { packaged: boolean; devUrl: string | undefined; rendererDir: string }): (url: string) => boolean {
  const dev = !options.packaged && options.devUrl ? new URL(options.devUrl).origin : null;
  const files = pathToFileURL(options.rendererDir).href.replace(/\/?$/, "/");
  return (url) => {
    if (url.startsWith(files) || url.startsWith("openorc-asset://")) return true;
    if (dev === null) return false;
    try {
      return new URL(url).origin === dev;
    } catch {
      return false;
    }
  };
}

/** Web permissions the app window uses. Every other permission, and any request from another page or frame, is refused. */
const APP_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);
export function permitted(permission: string, requestingUrl: string, isAppOrigin: (url: string) => boolean): boolean {
  return APP_PERMISSIONS.has(permission) && isAppOrigin(requestingUrl);
}

/** Only web pages leave the app for the system browser; files and other schemes do not. */
export function isExternalWebUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

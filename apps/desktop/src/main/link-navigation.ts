import { clipboard, dialog, shell, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from "electron";
import { hasBrowserContext, isAllowedPaneUrl, openBrowserLink } from "./browser-pane";
import { chromeExecutable, openChromeIncognito } from "./chrome-incognito";

const isWebLink = (url: string): boolean => url !== "about:blank" && isAllowedPaneUrl(url);

export function linkMenuItems(window: BrowserWindow, url: string): MenuItemConstructorOptions[] {
  if (!isWebLink(url)) return [];
  const chrome = chromeExecutable();
  return [
    ...(hasBrowserContext(window)
      ? [
          {
            label: "Open in sidebar",
            click: () => {
              openBrowserLink(window, url);
            },
          },
        ]
      : []),
    {
      label: "Open in default browser",
      click: () => {
        void shell.openExternal(url);
      },
    },
    ...(chrome
      ? [
          {
            label: "Open in Chrome Incognito",
            click: () => {
              void openChromeIncognito(chrome, url).catch((error: unknown) => {
                if (!window.isDestroyed())
                  void dialog.showMessageBox(window, { type: "error", message: "Could not open Chrome Incognito", detail: error instanceof Error ? error.message : "Please try again." });
              });
            },
          },
        ]
      : []),
    { type: "separator" },
    { label: "Copy link address", click: () => clipboard.writeText(url) },
  ];
}

/** Keep untrusted pages out of the app renderer, including target=_blank links. */
export function installLinkNavigation(window: BrowserWindow, isAppOrigin: (url: string) => boolean): void {
  const contents: WebContents = window.webContents;
  const open = (url: string) => {
    if (isWebLink(url) && !openBrowserLink(window, url)) void shell.openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isAppOrigin(url)) return;
    event.preventDefault();
    open(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

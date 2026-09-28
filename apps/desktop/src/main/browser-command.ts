import type { WebContents } from "electron";
import type { BrowserCommand, BrowserResult } from "@openorc/protocol";
import { inspectPage, interactWithPage, waitForPage } from "./browser-page";

interface BrowserActionInput {
  contents: WebContents;
  command: BrowserCommand;
  navigate: (url: string) => Promise<void>;
  readError: () => string | null;
  isAllowedUrl: (url: string) => boolean;
}

/** Execute one action against an already-authorized pane, owning its timeout and page sequencing. */
export async function runBrowserAction({ contents, command, navigate, readError, isAllowedUrl }: BrowserActionInput): Promise<BrowserResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const checkActive = () => {
    if (expired) throw new Error("The sidebar browser action timed out.");
  };
  const screenshot = async (): Promise<string> => {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const image = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    checkActive();
    if (typeof image.data !== "string" || !image.data) throw new Error("The preview has not painted yet. Retry the screenshot.");
    return image.data;
  };
  const operation = async (): Promise<BrowserResult> => {
    if (command.action === "open") {
      await navigate(command.url);
    } else {
      await waitForPage(contents);
      checkActive();
      if (!isAllowedUrl(contents.getURL()) || contents.getURL() === "about:blank") throw new Error("Open a website in the preview first.");
      const failure = readError();
      if (failure) throw new Error(failure);
      // A never-shown or just-resized view may not have a current hit-test
      // surface. Capture a frame before computing coordinates, without taking
      // OS focus or revealing a background conversation.
      if (command.action === "click" || command.action === "press") await screenshot();
      if (command.action !== "snapshot" && command.action !== "screenshot") {
        const refused = await interactWithPage(contents, command);
        if (refused) return { url: contents.getURL(), title: contents.getTitle(), refused };
      }
    }
    await waitForPage(contents);
    checkActive();
    const failure = readError();
    if (failure) throw new Error(failure);
    const result = { url: contents.getURL(), title: contents.getTitle() };
    if (command.action === "screenshot") {
      return { ...result, screenshot: { data: await screenshot(), mimeType: "image/png" } };
    }
    return { ...result, snapshot: await inspectPage(contents) };
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          if (!contents.isDestroyed()) contents.stop();
          reject(new Error("The sidebar browser action timed out. Check the preview and retry."));
        }, 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

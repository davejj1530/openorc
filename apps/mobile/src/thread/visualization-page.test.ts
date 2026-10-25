// @vitest-environment jsdom
import { visualizationColors, visualizationContextScript, visualizationCsp, visualizationDocument, type VisualizationContext } from "@openorc/client";
import { afterEach, expect, it } from "vitest";
import { colors } from "../generated/tokens";
import { readFrameMessage, type FrameMessage } from "./visualization-frame";

/** The page's context in a phone palette, read as the frame reads it. */
const contextIn = (theme: "light" | "dark", font: string): VisualizationContext => ({ theme, font, colors: visualizationColors((token) => colors[theme][token]) });
const dark = contextIn("dark", '"ImmaculateGothic-Text", system-ui');
const light = contextIn("light", "system-ui");

afterEach(() => document.body.replaceChildren());

type Page = Window & typeof globalThis;

/**
 * The phone's page as its web view runs it: at the top (its parent is itself), with React Native's bridge, which hands
 * the app every string the page posts. What arrives is read the way the app reads it.
 */
function load(html: string, context?: VisualizationContext) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const page = frame.contentWindow as Page;
  const posted: string[] = [];
  Object.defineProperty(page, "parent", { value: page });
  Object.assign(page, {
    ReactNativeWebView: { postMessage: (data: string) => posted.push(data) },
    ResizeObserver: class {
      observe() {}
    },
  });
  page.HTMLElement.prototype.getBoundingClientRect = () => ({ height: 240.4 }) as DOMRect;
  // The page reports a fragment's own errors; the test's console need not repeat them.
  page.addEventListener("error", (event) => event.preventDefault());
  const written = frame.contentDocument!;
  written.open();
  written.write(visualizationDocument(html, { host: "react-native", context }));
  written.close();
  const received = () => posted.map(readFrameMessage).filter((message): message is FrameMessage => message !== null);
  return { page, posted, received };
}

const settle = (page: Page) => new Promise((resolve) => page.requestAnimationFrame(() => setTimeout(resolve, 20)));

it("tells the app it is up and how tall it is, through the bridge", async () => {
  const { page, posted, received } = load("<p>Queue</p>");
  await settle(page);
  expect(posted.every((data) => typeof data === "string")).toBe(true);
  expect(received()).toEqual([
    { jsonrpc: "2.0", method: "ui/notifications/initialized" },
    { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 241 } },
  ]);
  expect(page.document.querySelector("main")!.innerHTML).toBe("<p>Queue</p>");
});

it("reports a fragment that throws, and again once it is up, so the app ends in the quiet error state", async () => {
  const { page, received } = load('<p>Queue</p><script>throw new Error("Bad step")</script>');
  await settle(page);
  const methods = received().map((message) => message.method);
  expect(methods.slice(0, 3)).toEqual(["openorc/visualization-error", "ui/notifications/initialized", "openorc/visualization-error"]);
  expect(received()[2]).toMatchObject({ params: { message: expect.stringContaining("Bad step") } });
});

it("carries the policy as its first element", () => {
  const { page } = load('<img src="https://example.com/a.png">');
  const first = page.document.head.firstElementChild!;
  expect(first.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  expect(first.getAttribute("content")).toBe(visualizationCsp);
});

it("paints in the phone's theme from the start and follows the context the app sends", async () => {
  const { page } = load("<p>x</p>", dark);
  const root = page.document.documentElement;
  expect(root.dataset.theme).toBe("dark");
  expect(root.style.getPropertyValue("--background")).toBe(colors.dark.surface);
  expect(page.document.body.style.fontFamily).toBe('"ImmaculateGothic-Text", system-ui');
  page.eval(visualizationContextScript(light));
  await settle(page);
  expect(root.dataset.theme).toBe("light");
  expect(root.style.colorScheme).toBe("light");
  expect(root.style.getPropertyValue("--background")).toBe(colors.light.surface);
  expect(root.style.getPropertyValue("--surface")).toBe(colors.light["surface-2"]);
  expect(page.document.body.style.fontFamily).toBe("system-ui");
});

it("ignores a context event that does not come from its parent", async () => {
  const { page } = load("<p>x</p>", dark);
  page.dispatchEvent(new page.MessageEvent("message", { data: { jsonrpc: "2.0", method: "openorc/visualization-context", params: light } }));
  await settle(page);
  expect(page.document.documentElement.dataset.theme).toBe("dark");
});

it("keeps a hostile starting value inside its attribute", () => {
  const { page } = load("<p>x</p>", { ...dark, font: 'x" onload="alert(1)" <b>' });
  expect(page.document.body.getAttributeNames()).toEqual(["style"]);
  expect(page.document.body.querySelector("b")).toBeNull();
});

it("never follows a link, tapped or clicked by the page's own script, which WebKit would connect to first", () => {
  const { page } = load('<a id="plain" href="https://example.com/">plain</a><svg><a id="drawn" href="https://example.com/"><text>drawn</text></a></svg><button id="button">Next</button>');
  const click = (id: string) => {
    const event = new page.MouseEvent("click", { bubbles: true, cancelable: true });
    page.document.getElementById(id)!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(click("plain")).toBe(true);
  expect(click("drawn")).toBe(true);
  expect(click("button")).toBe(false);
  const inner = new page.MouseEvent("click", { bubbles: true, cancelable: true });
  page.document.querySelector("text")!.dispatchEvent(inner);
  expect(inner.defaultPrevented).toBe(true);
});

it("draws its text at the reader's Text Size and follows it as it changes", async () => {
  const { page } = load("<p>x</p>", { ...dark, textScale: 1.3 });
  const root = page.document.documentElement;
  expect(root.style.getPropertyValue("-webkit-text-size-adjust")).toBe("130%");
  page.eval(visualizationContextScript({ ...light, textScale: 2 }));
  await settle(page);
  expect(root.style.getPropertyValue("-webkit-text-size-adjust")).toBe("200%");
});

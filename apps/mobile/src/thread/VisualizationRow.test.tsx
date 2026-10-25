// @vitest-environment jsdom
import { visualizationCsp } from "@openorc/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { colors } from "../generated/tokens";
import { flatStyle, nativeProps, screen as display } from "../test-fixtures/react-native";
import { injected } from "../test-fixtures/webview";
import { emptyRowMemo, transcriptRows, type Row } from "./rows";
import { VisualizationRow } from "./VisualizationRow";
import { createFrameWindow, FrameWindowContext, SETTLE_MS } from "./visualization-window";

vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
// The row's source opens through the tool rows, whose images read from the link; this row shows none.
vi.mock("../client", async () => {
  const { fakeLink } = await import("../test-fixtures/fake-link");
  return { useLinkRead: fakeLink().useLinkRead, assetUri: () => new Promise(() => undefined) };
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  display.fontScale = 1;
});

const input = { title: "How a queue works", description: "Items leave in the order they arrive.", html: '<button id="next">Next item</button>' };
const tool = { id: "viz", kind: "tool", name: "openorc.visualize", input, done: true, runId: "r", turnKey: "t1" } as const;
type VisualizationRowData = Extract<Row, { kind: "visualization" }>;
const row = transcriptRows([tool], { live: false, working: false }, "r", emptyRowMemo()).find((candidate): candidate is VisualizationRowData => candidate.kind === "visualization")!;

/** The row as the list shows it, once it has settled in its view and started its web view; every frame live unless the test's window says. */
function show(frames = createFrameWindow(true)) {
  const view = render(
    <FrameWindowContext.Provider value={frames}>
      <VisualizationRow row={row} />
    </FrameWindowContext.Provider>,
  );
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  return view;
}
const frame = () => screen.queryByRole("document", { name: input.title });
const props = () => nativeProps.get(frame()!)!;
type OnMessage = (event: { nativeEvent: { data: string } }) => void;
const post = (message: unknown) => act(() => (props().onMessage as OnMessage)({ nativeEvent: { data: typeof message === "string" ? message : JSON.stringify(message) } }));
const up = { jsonrpc: "2.0", method: "ui/notifications/initialized" };
const container = () => flatStyle(props().containerStyle);

it("places a finished visualize call as its own row after the work", () => {
  expect(row).toMatchObject({ kind: "visualization", key: "visualization:viz", block: tool, visualization: input });
});

it("loads the page as a sandbox: its own document at an opaque address, nothing else", () => {
  show();
  const view = props();
  const source = view.source as { html: string; baseUrl: string };
  expect(source.baseUrl).toBe("about:blank");
  expect(source.html).toContain(`content="${visualizationCsp}"`);
  expect(source.html).toContain("window.ReactNativeWebView.postMessage");
  expect(source.html).toContain(input.html);
  expect(view).toMatchObject({
    sandboxed: true,
    originWhitelist: ["*"],
    incognito: true,
    cacheEnabled: false,
    sharedCookiesEnabled: false,
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
    javaScriptCanOpenWindowsAutomatically: false,
    allowsLinkPreview: false,
    dataDetectorTypes: "none",
    mediaCapturePermissionGrantType: "deny",
    scrollEnabled: false,
  });
  expect(view.injectedJavaScript).toBeUndefined();
  expect(view.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  const guard = view.onShouldStartLoadWithRequest as (request: { url: string; isTopFrame: boolean }) => boolean;
  expect(guard({ url: "about:blank", isTopFrame: true })).toBe(true);
  expect(guard({ url: "https://example.com/", isTopFrame: true })).toBe(false);
  expect((view.onOpenWindow as (event: unknown) => unknown)({ nativeEvent: { targetUrl: "https://example.com/" } })).toBeUndefined();
});

it("shows the title, description and controls, the frame hidden until the page is up, then in the phone's theme", () => {
  show();
  expect(screen.getByText(input.title)).toBeTruthy();
  expect(screen.getByText(input.description)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  expect(screen.getByText("Loading visualization…")).toBeTruthy();
  expect(flatStyle(props().style).opacity).toBe(0);
  expect(container().height).toBe(320);
  post(up);
  expect(screen.queryByText("Loading visualization…")).toBeNull();
  expect(flatStyle(props().style).opacity).toBe(1);
  const [context] = injected.get(frame()!)!;
  expect(context).toContain("openorc/visualization-context");
  expect(context).toContain(`"--background":"${colors.light.surface}"`);
  expect(context).toContain(`"--surface":"${colors.light["surface-2"]}"`);
});

it("follows the page's height within the desktop's bounds and ignores anything else it posts", () => {
  show();
  post(up);
  post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 440 } });
  expect(container().height).toBe(440);
  for (const junk of [
    "not json",
    '{"jsonrpc":"2.0","method":"ui/notifications/size-changed","params":{"height":1e999}}',
    { jsonrpc: "2.0", method: "tools/call", params: {} },
    { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" },
  ])
    post(junk);
  expect(container().height).toBe(440);
  expect(screen.queryByText(/Visualization unavailable/)).toBeNull();
  post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9000 } });
  expect(container().height).toBe(1200);
});

it("trades the frame for a quiet line when the page fails, the description standing in", () => {
  show();
  post(up);
  post({ jsonrpc: "2.0", method: "openorc/visualization-error", params: { message: "An interaction could not finish." } });
  expect(screen.getByText("Visualization unavailable: An interaction could not finish.")).toBeTruthy();
  expect(container().height).toBe(0);
  expect(screen.getByText(input.description)).toBeTruthy();
});

it("fails quietly when the page never comes up, or its process ends", () => {
  const first = show();
  act(() => void vi.advanceTimersByTime(15_000));
  expect(screen.getByText("Visualization unavailable: This visualization did not finish loading. Try Reset.")).toBeTruthy();
  first.unmount();
  show();
  post(up);
  act(() => void (props().onContentProcessDidTerminate as () => void)());
  expect(screen.getByText("Visualization unavailable: This visualization stopped. Try Reset.")).toBeTruthy();
});

it("counts a page's time to come up only while it is on screen, and shows a page that comes up late after all", () => {
  const frames = createFrameWindow();
  show(frames);
  act(() => frames.update(new Set([row.key]), new Set()));
  act(() => void vi.advanceTimersByTime(60_000));
  expect(screen.getByText("Loading visualization…")).toBeTruthy();
  act(() => frames.update(new Set([row.key]), new Set([row.key])));
  act(() => void vi.advanceTimersByTime(15_000));
  expect(screen.getByText(/did not finish loading/)).toBeTruthy();
  post(up);
  expect(screen.queryByText(/Visualization unavailable/)).toBeNull();
  expect(container().height).toBe(320);
});

it("hides and shows the frame, and Reset gives it a fresh page that may load once again", () => {
  show();
  const guard = () => props().onShouldStartLoadWithRequest as (request: { url: string; isTopFrame: boolean }) => boolean;
  expect(guard()({ url: "about:blank", isTopFrame: true })).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Hide visualization" }));
  expect(frame()).toBeNull();
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show visualization" }));
  expect(frame()).toBeTruthy();
  expect(guard()({ url: "about:blank", isTopFrame: true })).toBe(true);
  expect(guard()({ url: "about:blank", isTopFrame: true })).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(guard()({ url: "about:blank", isTopFrame: true })).toBe(true);
});

it("keeps its place without a web view while the list holds it away from the screen, at the height it had", () => {
  const frames = createFrameWindow();
  const view = show(frames);
  expect(frame()).toBeNull();
  act(() => frames.update(new Set([row.key])));
  post(up);
  post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 412 } });
  act(() => frames.update(new Set()));
  expect(frame()).toBeNull();
  const space = Array.from(view.container.querySelectorAll("div"));
  expect(space.some((node) => flatStyle(nativeProps.get(node)?.style).height === 412)).toBe(true);
  act(() => frames.update(new Set([row.key])));
  expect(container().height).toBe(412);
});

it("starts no web view in a row the list moves on before it settles", () => {
  const moved = render(
    <FrameWindowContext.Provider value={createFrameWindow(true)}>
      <VisualizationRow row={row} />
    </FrameWindowContext.Provider>,
  );
  act(() => void vi.advanceTimersByTime(SETTLE_MS - 1));
  expect(frame()).toBeNull();
  moved.unmount();
  show();
  expect(frame()).toBeTruthy();
});

/** A row the list holds live, its web view up, then a page that fails while loading, as a fragment that throws does. */
function failedInWindow() {
  const frames = createFrameWindow();
  const view = show(frames);
  act(() => frames.update(new Set([row.key])));
  const failed = { jsonrpc: "2.0", method: "openorc/visualization-error", params: { message: "Bad step" } };
  for (const message of [failed, up, failed, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 40 } }]) post(message);
  return { frames, view };
}
const quietLine = () => screen.queryByText("Visualization unavailable: Bad step");

it("keeps a failed page's quiet line while it has no web view, and brings it back as that line until Reset", () => {
  const { frames, view } = failedInWindow();
  expect(quietLine()).toBeTruthy();
  expect(container().height).toBe(0);
  act(() => frames.update(new Set()));
  expect(frame()).toBeNull();
  expect(quietLine()).toBeTruthy();
  const boxes = Array.from(view.container.querySelectorAll("div")).filter((node) => flatStyle(nativeProps.get(node)?.style).height !== undefined);
  expect(boxes).toEqual([]);
  act(() => frames.update(new Set([row.key])));
  expect(frame()).toBeNull();
  expect(quietLine()).toBeTruthy();
  expect(screen.queryByText("Loading visualization…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(frame()).toBeTruthy();
  expect(screen.getByText("Loading visualization…")).toBeTruthy();
  expect(quietLine()).toBeNull();
});

it("gives a failed page a fresh load when it is shown again, as the desktop does", () => {
  failedInWindow();
  fireEvent.click(screen.getByRole("button", { name: "Hide visualization" }));
  expect(quietLine()).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show visualization" }));
  expect(frame()).toBeTruthy();
  expect(screen.getByText("Loading visualization…")).toBeTruthy();
});

it("draws the page's text at the reader's Text Size, from the first paint and as it changes", () => {
  display.fontScale = 1.5;
  show();
  expect((props().source as { html: string }).html).toContain("-webkit-text-size-adjust:150%");
  post(up);
  const [context] = injected.get(frame()!)!;
  expect(context).toContain('"textScale":1.5');
});

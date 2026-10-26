// @vitest-environment jsdom
import type { PreviewState, RpcMethod } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { copied } from "../test-fixtures/clipboard";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { opened } from "../test-fixtures/web-browser";
import { PreviewScreen } from "./PreviewScreen";

const studio = { id: "mac-1", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const page = (patch: Partial<Extract<PreviewState, { open: true }>> = {}): PreviewState => ({
  open: true,
  pane: "p1",
  address: "http://127.0.0.1:47831/",
  title: "QA Page",
  phase: "live",
  error: null,
  frame: null,
  ...patch,
});

/** The QA Mac as the screen meets it: the watch's answer, the thread screen's read, and the header the screen drew. */
const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  watch: (): Promise<unknown> => Promise.resolve(null),
  read: null as PreviewState | null,
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod) => (method === "preview.state" && mac.read ? Promise.resolve(mac.read) : Promise.reject(new Error(`no ${method}`))));
  const connection = {
    ...mac.phone.module.link.connection,
    session: (method: string) => (method === "preview.watch" ? mac.watch() : Promise.resolve(null)),
    asset: () => new Promise(() => undefined),
    onPreview: () => () => undefined,
  };
  return { ...mac.phone.module, link: { connection }, useLinkState: () => connected };
});
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: () => 0,
  KeyboardStickyView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  // The header's title draws where a test can read it.
  Stack.Screen = ({ options }: { options?: { headerTitle?: () => ReactNode } }) => <div data-testid="title">{options?.headerTitle?.()}</div>;
  const Toolbar = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Toolbar.Menu = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => <div aria-label={accessibilityLabel}>{children}</div>;
  Toolbar.MenuAction = ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => <button onClick={onPress}>{children}</button>;
  Stack.Toolbar = Toolbar;
  return { Stack, useLocalSearchParams: () => ({ threadId: "t1" }), useIsFocused: () => true };
});

beforeEach(() => {
  mac.read = null;
  copied.length = 0;
  opened.length = 0;
  mac.phone!.module.queryClient.clear();
});
afterEach(cleanup);

const opens = async (answer: PreviewState | Error) => {
  mac.watch = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
  render(<PreviewScreen />, { wrapper: mac.phone!.wrapper });
  await act(async () => undefined);
};
const line = () => screen.getByRole("header").getAttribute("aria-label");

it("names the page it opens by the thread screen's read, before the Mac answers", async () => {
  mac.read = page({ title: "" });
  mac.watch = () => new Promise(() => undefined);
  render(<PreviewScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(line()).toBe("Preview, 127.0.0.1:47831"));
});

it("says the page is closed on the Mac, with no line and no page menu", async () => {
  await opens({ open: false });
  expect(screen.getByText("Preview is closed on Studio")).toBeTruthy();
  expect(line()).toBe("Preview");
  expect(screen.queryByLabelText("Page")).toBeNull();
});

it("loads a page under its host until its first frame", async () => {
  await opens(page({ phase: "loading", title: "" }));
  expect(screen.getByText("Loading 127.0.0.1:47831…")).toBeTruthy();
  expect(line()).toBe("Preview, 127.0.0.1:47831");
});

it("says a page failed in the Mac's words, with no Retry, and when it stopped", async () => {
  await opens(page({ phase: "failed", error: "Nothing is listening on localhost:5173 yet." }));
  expect(screen.getByText("Could not load the preview")).toBeTruthy();
  expect(screen.getByText("Nothing is listening on localhost:5173 yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  cleanup();
  await opens(page({ phase: "stopped" }));
  expect(screen.getByText("The preview stopped")).toBeTruthy();
  expect(screen.getByText("Reload it on Studio.")).toBeTruthy();
});

it("says why the Mac refused, and asks an older Mac to update", async () => {
  await opens(new Error("This thread is gone."));
  expect(screen.getByText("This thread is gone.")).toBeTruthy();
  cleanup();
  await opens(new Error("This is not available from a phone."));
  expect(screen.getByText("Update OpenOrc on Studio to see its Preview.")).toBeTruthy();
});

it("copies the page's address, and opens only a public one in Safari", async () => {
  await opens(page());
  expect(screen.queryByText("Open in Safari")).toBeNull();
  fireEvent.click(screen.getByText("Copy Address"));
  await waitFor(() => expect(copied).toEqual(["http://127.0.0.1:47831/"]));
  cleanup();
  await opens(page({ address: "https://example.com/docs" }));
  fireEvent.click(screen.getByText("Open in Safari"));
  expect(opened).toEqual(["https://example.com/docs"]);
});

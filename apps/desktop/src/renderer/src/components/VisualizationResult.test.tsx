import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import VisualizationResult from "./VisualizationResult";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const visualization = { title: "How a queue works", description: "Items leave in the order they arrive.", html: '<button id="next">Next item</button>' };
const registration = { id: "view", url: "http://127.0.0.1:32123/view/proxy" };

it("loads the sandbox, rejects unrelated frame messages, and releases it on hide and reset", async () => {
  const register = vi.fn().mockResolvedValue(registration);
  const release = vi.fn();
  vi.stubGlobal("openorc", { mcpApps: { register, release } });
  render(<VisualizationResult visualization={visualization} />);
  const iframe = screen.getByTitle(visualization.title);
  expect(iframe).toBeInstanceOf(HTMLIFrameElement);
  if (!(iframe instanceof HTMLIFrameElement)) throw new Error("Missing visualization frame");
  await waitFor(() => expect(iframe.getAttribute("src")).toBe(registration.url));
  expect(screen.getByText(visualization.description)).toBeTruthy();
  expect(register).toHaveBeenCalledWith({ html: expect.stringContaining(visualization.html), csp: {} });
  const source = iframe.contentWindow;
  const origin = new URL(registration.url).origin;
  const ready = { jsonrpc: "2.0", method: "ui/notifications/initialized" };
  fireEvent(window, new MessageEvent("message", { source: window, origin, data: ready }));
  fireEvent(window, new MessageEvent("message", { source, origin: "https://unrelated.example", data: ready }));
  expect(screen.getByText("Loading visualization…")).toBeTruthy();
  fireEvent(window, new MessageEvent("message", { source, origin, data: ready }));
  expect(screen.queryByText("Loading visualization…")).toBeNull();
  fireEvent(window, new MessageEvent("message", { source, origin, data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 440 } } }));
  expect(iframe.style.height).toBe("440px");
  fireEvent(window, new MessageEvent("message", { source, origin, data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: Infinity } } }));
  expect(iframe.style.height).toBe("440px");
  fireEvent.click(screen.getByRole("button", { name: "Hide visualization" }));
  expect(release).toHaveBeenCalledWith("view");
  expect(screen.queryByTitle(visualization.title)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show visualization" }));
  await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => expect(register).toHaveBeenCalledTimes(3));
  expect(release).toHaveBeenCalledTimes(2);
});

it("keeps a readable explanation when the sandbox is unavailable", async () => {
  vi.stubGlobal("openorc", { mcpApps: { register: vi.fn().mockRejectedValue(new Error("Sandbox unavailable")), release: vi.fn() } });
  render(<VisualizationResult visualization={visualization} />);
  expect(await screen.findByText("Visualization unavailable: Sandbox unavailable")).toBeTruthy();
  expect(screen.getByText(visualization.description)).toBeTruthy();
});

it("releases a registration that finishes after the view closes", async () => {
  let resolve: (value: typeof registration) => void = () => {};
  const release = vi.fn();
  vi.stubGlobal("openorc", {
    mcpApps: {
      register: () =>
        new Promise<typeof registration>((done) => {
          resolve = done;
        }),
      release,
    },
  });
  const view = render(<VisualizationResult visualization={visualization} />);
  view.unmount();
  resolve(registration);
  await waitFor(() => expect(release).toHaveBeenCalledWith("view"));
});

/** The view as it comes up, from the frame the sandbox loaded, with the channel the page hands over. */
async function bringUp() {
  const register = vi.fn().mockResolvedValue(registration);
  const release = vi.fn();
  vi.stubGlobal("openorc", { mcpApps: { register, release } });
  render(<VisualizationResult visualization={visualization} />);
  const iframe = screen.getByTitle(visualization.title) as HTMLIFrameElement;
  await waitFor(() => expect(iframe.getAttribute("src")).toBe(registration.url));
  const lifeline = new MessageChannel();
  const up = { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} };
  fireEvent(window, new MessageEvent("message", { source: iframe.contentWindow, origin: new URL(registration.url).origin, data: up, ports: [lifeline.port2] }));
  expect(screen.queryByText("Loading visualization…")).toBeNull();
  return { register, release, lifeline };
}

it("folds a page whose renderer ended after it was up into its quiet line, and Reset brings a new one", async () => {
  const { register, release, lifeline } = await bringUp();
  lifeline.port1.close();
  expect(await screen.findByText("Visualization unavailable: This visualization stopped. Try Reset.")).toBeTruthy();
  expect(screen.queryByTitle(visualization.title)).toBeNull();
  expect(release).toHaveBeenCalledWith("view");
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
  expect(screen.getByTitle(visualization.title)).toBeTruthy();
});

it("lets go of a page that never comes up, so the renderer it may hold in a loop can end", async () => {
  vi.useFakeTimers();
  const register = vi.fn().mockResolvedValue(registration);
  const release = vi.fn();
  vi.stubGlobal("openorc", { mcpApps: { register, release } });
  render(<VisualizationResult visualization={visualization} />);
  await act(async () => {});
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  expect(screen.getByText("Visualization unavailable: This visualization did not finish loading. Try Reset.")).toBeTruthy();
  expect(screen.queryByTitle(visualization.title)).toBeNull();
  expect(release).toHaveBeenCalledWith("view");
});

it("loads a page that hands its host one end of a channel as it comes up and keeps the other", async () => {
  const register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal("openorc", { mcpApps: { register, release: vi.fn() } });
  render(<VisualizationResult visualization={visualization} />);
  await waitFor(() => expect(register).toHaveBeenCalled());
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const page = frame.contentWindow as Window & typeof globalThis;
  const posted: { method: string; transfer: unknown[] }[] = [];
  Object.defineProperty(page, "parent", { value: { postMessage: (message: { method: string }, _origin: string, transfer: unknown[] = []) => posted.push({ method: message.method, transfer }) } });
  Object.assign(page, {
    MessageChannel,
    ResizeObserver: class {
      observe() {}
    },
  });
  page.document.open();
  page.document.write((register.mock.calls[0]![0] as { html: string }).html);
  page.document.close();
  await waitFor(() => expect(posted.map(({ method }) => method)).toContain("ui/notifications/initialized"));
  const [port] = posted.find(({ method }) => method === "ui/notifications/initialized")!.transfer as MessagePort[];
  expect(port).toBeInstanceOf(MessagePort);
  let closed = false;
  port!.addEventListener("close", () => (closed = true));
  port!.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closed).toBe(false);
  frame.remove();
});

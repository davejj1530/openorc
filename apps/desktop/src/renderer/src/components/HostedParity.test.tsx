import { Menu } from "@base-ui/react/menu";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REASONS, type RpcMethod, type RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { PanelContent } from "./PanelContent";
import { PanelNewTab } from "./PanelNewTab";
import { ThreadMenuItems } from "./ThreadActions";
import { ToolRow } from "./ToolRow";
import McpAppResult from "./McpAppResult";
import { cloudReviewThread, localReviewThread, reviewProject } from "./test-fixtures/hosted-review";

vi.mock("../lib/orclings", () => ({ useOrclings: () => [], useOrclingGroups: () => [], orclingHome: () => null }));
const context = { kind: "thread" as const, thread: cloudReviewThread, project: reviewProject };
beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "hosted.capabilities") return { version: 1, features: {} } as RpcResults[M];
    if (method === "cloud.offer") return { offered: false } as RpcResults[M];
    throw new Error(`Unexpected local read: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
const mount = (element: React.ReactNode) => render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);

it.each([
  ["plan", "plans"],
  ["checkpoints", "checkpoints"],
  ["instructions", "instructions"],
  ["memory", "memory"],
  ["tasks", "tasks"],
] as const)("an already open hosted %s panel shows unavailable without reading local data", async (tool, control) => {
  mount(<PanelContent context={context} page={{ kind: "tool", tool }} onNavigate={() => undefined} />);
  expect(await screen.findByText(HOSTED_REASONS[control])).toBeTruthy();
  expect(vi.mocked(core.call).mock.calls.every(([method]) => method === "hosted.capabilities")).toBe(true);
});

it("offers disabled Files in its normal place with its reason on keyboard focus", async () => {
  const onTool = vi.fn();
  mount(<PanelNewTab context={context} onTool={onTool} onNavigate={() => undefined} recentUrls={[]} />);
  const files = screen.getByRole("button", { name: /^Files$/ });
  expect(files.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText(HOSTED_REASONS.fileBrowser)).toBeNull();
  await act(async () => screen.getByLabelText("Files").focus());
  expect(await screen.findByText(HOSTED_REASONS.fileBrowser)).toBeTruthy();
  fireEvent.click(files);
  expect(onTool).not.toHaveBeenCalled();
});

it("keeps a local launcher enabled and calls its existing action", () => {
  const onTool = vi.fn();
  mount(<PanelNewTab context={{ ...context, thread: localReviewThread }} onTool={onTool} onNavigate={() => undefined} recentUrls={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /^Files$/ }));
  expect(onTool).toHaveBeenCalledWith("file");
  expect(vi.mocked(core.call)).not.toHaveBeenCalled();
});

it("keeps Fork and New subthread disabled with keyboard-reachable reasons", async () => {
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={cloudReviewThread} parts={Menu} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
  const fork = screen.getByRole("menuitem", { name: /^Fork$/ });
  expect(fork.getAttribute("aria-disabled")).toBe("true");
  await act(async () => fork.focus());
  expect(await screen.findByText(HOSTED_REASONS.fork)).toBeTruthy();
  const child = screen.getByRole("menuitem", { name: /^New subthread$/ });
  expect(child.getAttribute("aria-disabled")).toBe("true");
  await act(async () => child.focus());
  expect(await screen.findByText(HOSTED_REASONS.personSubthreads)).toBeTruthy();
});

it("does not fetch omitted hosted tool output on hover or focus", async () => {
  mount(<ToolRow block={{ id: "tool-1", kind: "tool", name: "Read", input: { path: "example.ts" }, outputOmitted: true, done: true, runId: "hosted:example-thread" }} />);
  const row = screen.getByRole("button");
  fireEvent.pointerEnter(row);
  fireEvent.focus(row);
  fireEvent.click(row);
  expect(await screen.findByRole("button", { name: "Full output" })).toBeTruthy();
  expect(vi.mocked(core.call)).not.toHaveBeenCalled();
});

it("does not open a local interactive tool app for a hosted run", async () => {
  mount(<McpAppResult runId="hosted:example-thread" toolCallId="call-1" />);
  const button = screen.getByRole("button", { name: "Open interactive app" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => button.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.interactiveApp)).toBeTruthy();
  expect(core.call).not.toHaveBeenCalled();
});

it("keeps cloud relocation and code-copy controls disabled in the place menu", async () => {
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={cloudReviewThread} parts={Menu} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  const bring = await screen.findByRole("menuitem", { name: /Bring to Mac/ });
  expect(bring.getAttribute("aria-disabled")).toBe("true");
  await act(async () => bring.focus());
  expect(await screen.findByText(HOSTED_REASONS.moveToMac)).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /Open on Mac/ }).getAttribute("aria-disabled")).toBe("true");
});

import { Menu } from "@base-ui/react/menu";
import { CoversPreview } from "../lib/browser-preview";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REASONS, type RpcMethod, type RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
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
  expect(screen.queryByText(HOSTED_REASONS[control])).toBeNull();
  const disabled = screen.getByRole("button", { name: /unavailable$/ });
  expect(disabled.hasAttribute("disabled")).toBe(true);
  await act(async () => disabled.parentElement?.focus());
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
        <CoversPreview />
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

it("starts a subthread under a cloud thread once its server says it may, as under a thread on this Mac", async () => {
  vi.mocked(core.call).mockImplementation((async (method: RpcMethod) => {
    if (method === "hosted.capabilities") return { version: 1, features: { personSubthreads: { available: true } } };
    throw new Error(`Unexpected local read: ${method}`);
  }) as never);
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={cloudReviewThread} parts={Menu} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
  // Held while its server is asked, then offered as on this Mac.
  await vi.waitFor(() => expect(screen.getByRole("menuitem", { name: /^New subthread$/ }).getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(screen.getByRole("menuitem", { name: /^New subthread$/ }));
  expect(useRouter.getState().route).toEqual({ view: "newsubthread", parentId: cloudReviewThread.id });
  expect(screen.getByRole("menuitem", { name: /^Fork$/ }).getAttribute("aria-disabled")).toBe("true");
});

it("forks a cloud thread once its server serves forks, and opens the fork", async () => {
  vi.mocked(core.call).mockImplementation((async (method: RpcMethod) => {
    if (method === "hosted.capabilities") return { version: 1, features: { fork: { available: true } } };
    if (method === "threads.fork") return { ...cloudReviewThread, id: "fork-thread", title: `${cloudReviewThread.title} (fork)` };
    throw new Error(`Unexpected local read: ${method}`);
  }) as never);
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={cloudReviewThread} parts={Menu} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
  await vi.waitFor(() => expect(screen.getByRole("menuitem", { name: /^Fork$/ }).getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(screen.getByRole("menuitem", { name: /^Fork$/ }));
  await vi.waitFor(() => expect(vi.mocked(core.call)).toHaveBeenCalledWith("threads.fork", { id: cloudReviewThread.id }));
  await vi.waitFor(() => expect(useRouter.getState().route).toMatchObject({ view: "thread", threadId: "fork-thread" }));
});

it("reads an omitted cloud tool output when its row opens, as a Mac one's", async () => {
  vi.mocked(core.call).mockImplementation((async (method: string) => (method === "events.toolOutput" ? { output: "the whole cloud output" } : undefined)) as never);
  mount(<ToolRow block={{ id: "tool-1", kind: "tool", name: "mobbin.search_screens", input: { query: "onboarding" }, outputOmitted: true, done: true, runId: "hosted:example-thread" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Mobbin search screens/ }));
  await vi.waitFor(() => expect(core.call).toHaveBeenCalledWith("events.toolOutput", { runId: "hosted:example-thread", toolCallId: "tool-1" }));
  expect(await screen.findByText(/the whole cloud output/)).toBeTruthy();
});

it("holds a cloud run's interactive app with its reason while its server serves none, opening nothing", async () => {
  queryClient.setQueryData(["threads.get", { id: cloudReviewThread.id }], cloudReviewThread);
  mount(<McpAppResult runId={`hosted:${cloudReviewThread.id}`} toolCallId="call-1" />);
  const button = screen.getByRole("button", { name: "Open interactive app" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => button.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.interactiveApp)).toBeTruthy();
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("mcpApps.open");
});

it("opens a cloud run's interactive app where its run is, once its server serves them", async () => {
  queryClient.setQueryData(["threads.get", { id: cloudReviewThread.id }], cloudReviewThread);
  vi.mocked(core.call).mockImplementation((async (method: RpcMethod) => {
    if (method === "hosted.capabilities") return { version: 1, features: { interactiveApp: { available: true } } };
    if (method === "mcpApps.open") return { status: "unavailable", message: "Interactive apps need the thread's agent running. The saved result is still available." };
    throw new Error(`Unexpected local read: ${method}`);
  }) as never);
  mount(<McpAppResult runId={`hosted:${cloudReviewThread.id}`} toolCallId="call-1" />);
  expect(await screen.findByText(/Interactive apps need the thread's agent running/)).toBeTruthy();
  expect(vi.mocked(core.call)).toHaveBeenCalledWith("mcpApps.open", { runId: `hosted:${cloudReviewThread.id}`, toolCallId: "call-1" });
});

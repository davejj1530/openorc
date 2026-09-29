import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo } from "@openorc/protocol";

vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/RiveMascot", () => ({ RiveMascot: () => null }));
vi.mock("./components/Sidebar", () => ({
  Sidebar: () => <nav aria-label="Workspace" />,
}));
vi.mock("./components/ThreadActions", () => ({
  DeleteThreadDialog: () => null,
}));
vi.mock("./components/TeamMoveDialog", () => ({ TeamMoveDialog: () => null }));
vi.mock("./components/ThreadMoveDialog", () => ({ ThreadMoveDialog: () => null }));
vi.mock("./dialogs/ImportProjectDialog", () => ({
  ImportProjectDialog: () => null,
}));
vi.mock("./dialogs/ImportSessionsDialog", () => ({
  ImportSessionsDialog: () => null,
}));
vi.mock("./views/Inbox", () => ({ Inbox: () => null }));
vi.mock("./views/Memory", () => ({ Memory: () => null }));
vi.mock("./views/NewThread", () => ({
  NewThread: () => <div>New conversation</div>,
}));
vi.mock("./views/Orchestration", () => ({ Orchestration: () => null }));
vi.mock("./views/ProjectView", () => ({ ProjectView: () => null }));
vi.mock("./views/Scheduled", () => ({ Scheduled: () => null }));
vi.mock("./views/Settings", () => ({ Settings: () => null }));
vi.mock("./views/TaskList", () => ({ TaskListView: () => null }));
vi.mock("./components/ThreadWorkspace", () => ({ ThreadWorkspace: () => null }));
vi.mock("./lib/rpc", () => ({ core: { call: vi.fn() } }));
vi.mock("./lib/ui", () => ({
  useUi: () => ({ importSessions: { open: false } }),
}));
let trafficLights = true;
vi.mock("./lib/window", () => ({ useTrafficLights: () => trafficLights, useWindowsControls: () => false }));

let harnesses: HarnessInfo[] | undefined;
let projectCount = 1;
let checkFailed = false;
vi.mock("./lib/query", () => {
  const rpcData = (method: string) => {
    if (method === "system.info") return harnesses ? { harnesses } : undefined;
    return Array.from({ length: projectCount }, (_, i) => ({
      id: `project-${i}`,
      name: "Existing project",
      rootPath: "/tmp/project",
    }));
  };
  return {
    queryClient: { setQueryData: vi.fn() },
    useRpc: (method: string) => ({
      data: rpcData(method),
      isLoading: method === "system.info" && !harnesses,
      isError: method === "system.info" && checkFailed,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useRpcMutation: () => ({
      isPending: false,
      isError: false,
      data: undefined,
      error: null,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    }),
  };
});

import { App } from "./App";
import { useRouter } from "./lib/router";
import { writeOnboardingState } from "./lib/onboarding";

const harness = (id: HarnessInfo["id"], state: HarnessInfo["state"]): HarnessInfo => ({
  id,
  state,
  path: `/usr/local/bin/${id}`,
  version: "1.0",
  revision: 1,
});
const bothReady = () => [harness("claude", "ready"), harness("codex", "ready")];
const recoveryHeading = () => screen.queryByRole("heading", { name: "Reconnect your coding agent" });

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  useRouter.setState({ route: { view: "newthread" }, history: [], future: [] });
  harnesses = undefined;
  projectCount = 1;
  checkFailed = false;
  trafficLights = true;
});

describe("app onboarding recovery", () => {
  it("reserves native traffic-light space while the initial setup check is pending", () => {
    const view = render(<App />);
    expect(screen.getByLabelText("Checking setup")).toBeTruthy();
    expect(screen.getByText("OpenOrc").closest("header")?.getAttribute("data-traffic-lights")).toBe("true");
    trafficLights = false;
    view.rerender(<App />);
    expect(screen.getByText("OpenOrc").closest("header")?.hasAttribute("data-traffic-lights")).toBe(false);
  });

  it("can return from an explicit recovery route with no navigation history", () => {
    harnesses = bothReady();
    useRouter.setState({ route: { view: "onboarding", mode: "recovery" } });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Return to OpenOrc" }));
    expect(recoveryHeading()).toBeNull();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
  });

  it("can close a failed recovery check and browse existing work", () => {
    harnesses = [];
    checkFailed = true;
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    view.rerender(<App />);
    expect(recoveryHeading()).toBeNull();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
  });

  it("returns to the previous screen when recovery was opened from settings", () => {
    harnesses = bothReady();
    useRouter.setState({
      route: { view: "onboarding", mode: "recovery" },
      history: [{ view: "settings" }],
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useRouter.getState().route).toEqual({ view: "settings" });
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
  });

  it("keeps first-run setup working through agent and default selection", () => {
    projectCount = 0;
    const view = render(<App />);
    harnesses = bothReady();
    view.rerender(<App />);
    expect(screen.getByRole("heading", { name: "Use the agents you already have" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Start new threads with" }), { target: { value: "claude" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("heading", { name: "Choose how OpenOrc looks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("heading", { name: "Bring in your first project" })).toBeTruthy();
    projectCount = 1;
    view.rerender(<App />);
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    expect(screen.getByRole("heading", { name: "Ready to work" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start your first thread/i }));
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
    expect(useRouter.getState().route).toEqual({
      view: "newthread",
      projectId: "project-0",
    });
  });

  it("does not latch recovery during loading for a completed profile", () => {
    writeOnboardingState({
      version: 1,
      step: "done",
      completedAt: 1,
      selectedHarnesses: ["claude"],
      defaultHarness: "claude",
    });
    const view = render(<App />);
    harnesses = bothReady();
    view.rerender(<App />);
    expect(recoveryHeading()).toBeNull();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
  });

  it("returns after agents recover even without a saved default", () => {
    harnesses = [harness("claude", "sign_in"), harness("codex", "sign_in")];
    const view = render(<App />);
    expect(recoveryHeading()).toBeTruthy();
    harnesses = bothReady();
    view.rerender(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Return to OpenOrc" }));
    expect(recoveryHeading()).toBeNull();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
    view.rerender(<App />);
    expect(recoveryHeading()).toBeNull();
  });
});

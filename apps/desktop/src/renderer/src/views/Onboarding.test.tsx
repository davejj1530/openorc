import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo, Project } from "@openorc/protocol";

const navigate = vi.fn();
const back = vi.fn();
const rescanSystem = vi.fn();
let harnesses: HarnessInfo[] = [];
let systemLoading = false;
let projectList: Project[] = [];
let projectLoading = false;
let projectFailed = false;
const refetchProjects = vi.fn();
const importRepository = vi.fn();
const pickDirectory = vi.fn();
const project: Project = {
  id: "p1",
  name: "My project",
  rootPath: "/Users/test/project",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};

vi.mock("../lib/router", () => ({
  useRouter: (select: (state: { navigate: typeof navigate; back: typeof back }) => unknown) => select({ navigate, back }),
}));

vi.mock("../lib/window", () => ({ useTrafficLights: () => true }));

vi.mock("../components/RiveMascot", () => ({
  RiveMascot: ({ reaction, reactionKey }: { reaction?: string; reactionKey?: string }) => <div className="rive-mascot" data-reaction={reaction} data-reaction-key={reactionKey} />,
}));

vi.mock("../lib/query", () => ({
  queryClient: { setQueryData: vi.fn() },
  useRpc: (method: string) =>
    method === "system.info"
      ? {
          data: { harnesses },
          isLoading: systemLoading,
          isError: false,
          isFetching: false,
        }
      : {
          data: projectList,
          isLoading: projectLoading,
          isError: projectFailed,
          isFetching: false,
          refetch: refetchProjects,
        },
  useRpcMutation: () => ({
    isPending: false,
    isError: false,
    data: undefined,
    error: null,
    mutate: (...args: unknown[]) => rescanSystem(...args),
    mutateAsync: importRepository,
  }),
}));

import { useTheme } from "../lib/theme";
import { Onboarding } from "./Onboarding";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  navigate.mockReset();
  back.mockReset();
  rescanSystem.mockClear();
  useTheme.setState({
    choice: "system",
    preset: "codex",
    resolved: "light",
    custom: {},
  });
  harnesses = [];
  systemLoading = false;
  projectList = [];
  projectLoading = false;
  projectFailed = false;
  refetchProjects.mockReset();
  importRepository.mockReset();
  pickDirectory.mockReset();
  window.openorc = { ...window.openorc, pickDirectory };
});

const ready = (id: HarnessInfo["id"]): HarnessInfo => ({
  id,
  state: "ready",
  path: `/usr/local/bin/${id}`,
  version: "1.0.0",
  revision: 1,
});

describe("Onboarding", () => {
  it("reacts to agent checks resolving without changing setup focus or adding an announcement", () => {
    systemLoading = true;
    const view = render(<Onboarding />);
    const mascot = () => view.container.querySelector(".onboarding-mascot");
    expect(mascot()?.getAttribute("data-mood")).toBe("thinking");
    expect(mascot()?.getAttribute("aria-hidden")).toBe("true");

    systemLoading = false;
    harnesses = [ready("codex")];
    view.rerender(<Onboarding />);
    expect(mascot()?.getAttribute("data-mood")).toBe("pleased");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Use the agents you already have" }));

    harnesses = [{ ...ready("codex"), state: "check_failed" }];
    view.rerender(<Onboarding />);
    expect(mascot()?.getAttribute("data-mood")).toBe("reassuring");
  });

  it("applies the existing appearance and palette settings from the theme step", () => {
    harnesses = [ready("claude")];
    render(
      <Onboarding
        initialStep="theme"
        persisted={{
          version: 1,
          step: "theme",
          completedAt: null,
          selectedHarnesses: ["claude"],
          defaultHarness: "claude",
        }}
      />,
    );
    const reactionKey = () => document.querySelector(".rive-mascot")?.getAttribute("data-reaction-key");
    const firstPose = reactionKey();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    const darkPose = reactionKey();
    expect(darkPose).not.toBe(firstPose);
    fireEvent.click(screen.getByRole("button", { name: "Claude palette" }));
    expect(reactionKey()).not.toBe(darkPose);
    expect(document.querySelector(".rive-mascot")?.getAttribute("data-reaction")).toBe("Happy");
    expect(localStorage.getItem("openorc.theme")).toBe("dark");
    expect(localStorage.getItem("openorc.palette")).toBe("claude");
  });

  it("keeps preview controls disposable instead of issuing live rescans", () => {
    harnesses = [ready("claude"), ready("codex")];
    render(<Onboarding previewInitially />);
    expect(screen.getByText("Disposable preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    expect(rescanSystem).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Step/), {
      target: { value: "theme" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude palette" }));
    expect(localStorage.getItem("openorc.theme")).toBeNull();
    expect(localStorage.getItem("openorc.palette")).toBeNull();
    expect(screen.getByRole("figure", { name: "Claude workspace preview" })).toBeTruthy();
    expect(document.querySelector(".palette-workspace")?.getAttribute("data-preview-mode")).toBe("dark");
    fireEvent.change(screen.getByLabelText(/Step/), {
      target: { value: "done" },
    });
    expect(screen.getByRole("heading", { name: "Ready to work" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /reset preview/i }));
    expect(screen.getByRole("heading", { name: "Use the agents you already have" })).toBeTruthy();
  });

  it("disables Continue when every ready agent is deselected", () => {
    harnesses = [ready("claude"), ready("codex")];
    render(<Onboarding onPersist={() => true} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code selected" }));
    expect((screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex selected" }));
    expect((screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Select at least one ready agent to continue.")).toBeTruthy();
  });

  it("restores the former default step on the combined agents screen", () => {
    harnesses = [ready("claude"), ready("codex")];
    render(<Onboarding initialStep="default" persisted={{ version: 1, step: "default", completedAt: null, selectedHarnesses: ["claude", "codex"], defaultHarness: null }} />);
    expect(screen.getByRole("combobox", { name: "Start new threads with" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Use the agents you already have" })).toBeTruthy();
  });

  it("moves focus and accessible progress with the step, and persists Back", () => {
    harnesses = [ready("codex")];
    render(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose how OpenOrc looks" }));
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Appearance");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(JSON.parse(localStorage.getItem("openorc.onboarding")!).step).toBe("scan");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Use the agents you already have" }));
  });

  it("keeps cancellation quiet and recovers from picker and import failures", async () => {
    harnesses = [ready("codex")];
    pickDirectory.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Folder picker unavailable")).mockResolvedValue(project.rootPath);
    importRepository.mockRejectedValueOnce(new Error("Not a Git repository")).mockResolvedValue(project);
    render(<Onboarding initialStep="project" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose repository" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose repository" })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(importRepository).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose repository" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Folder picker unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Choose repository" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Not a Git repository"));
    expect(document.querySelector(".onboarding-mascot")?.getAttribute("data-mood")).toBe("reassuring");
    fireEvent.click(screen.getByRole("button", { name: "Choose repository" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /My project/ })).toHaveProperty("checked", true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows project loading and lets failed project lists retry", () => {
    projectLoading = true;
    const view = render(<Onboarding initialStep="project" />);
    expect(screen.getByRole("status").textContent).toContain("Loading your projects");
    expect(screen.queryByText("Start with a local repository")).toBeNull();
    projectLoading = false;
    projectFailed = true;
    view.rerender(<Onboarding initialStep="project" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading projects" }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
  });

  it("isolates simulated imports and choices when returning to live state", async () => {
    harnesses = [ready("codex")];
    render(<Onboarding initialStep="project" previewInitially />);
    fireEvent.click(screen.getByRole("button", { name: "Choose repository" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Example project/ })).toBeTruthy());
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(importRepository).not.toHaveBeenCalled();
    expect(localStorage.getItem("openorc.onboarding")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Use live state/ }));
    expect(screen.queryByRole("radio", { name: /Example project/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Finish setup/ })).toHaveProperty("disabled", true);
  });

  it("keeps the current step and choices when saving progress fails", () => {
    harnesses = [ready("codex")];
    render(<Onboarding onPersist={() => false} />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
    expect(screen.getByRole("heading", { name: "Use the agents you already have" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Codex selected" }).getAttribute("aria-checked")).toBe("true");
  });

  it("rescans during recovery and completes without replacing saved preferences", () => {
    harnesses = [ready("codex")];
    const onPersist = vi.fn(() => true);
    const onComplete = vi.fn();
    render(
      <Onboarding mode="recovery" persisted={{ version: 1, step: "done", completedAt: 123, selectedHarnesses: ["claude"], defaultHarness: "claude" }} onPersist={onPersist} onComplete={onComplete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    expect(rescanSystem).toHaveBeenCalledWith({ refresh: true }, expect.any(Object));
    fireEvent.click(screen.getByRole("button", { name: "Return to OpenOrc" }));
    expect(onPersist).toHaveBeenCalledWith(expect.objectContaining({ step: "done", completedAt: 123, selectedHarnesses: ["claude"], defaultHarness: "claude" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("saves the chosen default and project before starting the first thread", async () => {
    harnesses = [ready("codex"), ready("claude")];
    projectList = [project];
    render(<Onboarding />);
    fireEvent.change(screen.getByRole("combobox", { name: "Start new threads with" }), { target: { value: "claude" } });
    expect(JSON.parse(localStorage.getItem("openorc.onboarding")!).defaultHarness).toBe("claude");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /My project/ })).toHaveProperty("checked", true));
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    expect(screen.getByRole("heading", { name: "Ready to work" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start your first thread/i }));
    expect(navigate).toHaveBeenCalledWith({ view: "newthread", projectId: project.id });
    expect(JSON.parse(localStorage.getItem("openorc.onboarding")!)).toMatchObject({ step: "done", defaultHarness: "claude" });
  });
});

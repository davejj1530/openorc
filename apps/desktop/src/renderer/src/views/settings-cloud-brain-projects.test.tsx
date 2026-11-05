import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainProject, CloudBrainStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrainSection } from "./settings-cloud-brain";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui")>()),
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => <span data-tooltip={label}>{children}</span>,
}));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const ready: CloudBrainStatus = { state: "ready", region: "sin1", machine: "awake", claude: [], behind: false, working: null, door: null, error: null };
const project = (id: string, name: string, shown: Partial<CloudBrainProject> = {}): CloudBrainProject => ({ id, name, on: false, blocked: null, sending: false, kept: false, error: null, ...shown });

function show(projects: CloudBrainProject[], status: CloudBrainStatus = ready) {
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    if (method === "cloud.brain.projects") return projects as never;
    if (method === "cloud.brain.project") {
      const { projectId, on } = params as { projectId: string; on: boolean };
      return projects.map((each) => (each.id === projectId ? { ...each, on } : each)) as never;
    }
    if (method === "cloud.brain.signIns")
      return {
        codex: { mode: null, email: null, plan: null, signingIn: false, pending: null, error: null },
        github: { on: false, blocked: null, behind: false },
        push: { has: false, behind: false },
      } as never;
    return status as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudBrainSection active />
    </QueryClientProvider>,
  );
}

const toggle = (name: string) => screen.getByRole("switch", { name }) as HTMLInputElement;
const reason = (name: string) => toggle(name).closest("[data-tooltip]")?.getAttribute("data-tooltip") ?? null;

it("lists this Mac's projects under the brain with a switch each, and sends one switched on", async () => {
  show([project("p1", "app"), project("p2", "site", { on: true })]);
  await screen.findByText("Projects");
  expect([toggle("app").checked, toggle("site").checked]).toEqual([false, true]);
  expect([toggle("app").disabled, reason("app")]).toEqual([false, null]);
  fireEvent.click(toggle("app"));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.project", { projectId: "p1", on: true }));
  await waitFor(() => expect(toggle("app").checked).toBe(true));
});

it("disables a switch it cannot move, with the reason only on hover", async () => {
  show([project("p1", "notes", { blocked: "Not a Git repository." }), project("p2", "app", { on: true, blocked: "It has threads on the cloud brain." })]);
  await screen.findByText("Projects");
  expect([toggle("notes").checked, toggle("notes").disabled, reason("notes")]).toEqual([false, true, "Not a Git repository."]);
  expect([toggle("app").checked, toggle("app").disabled, reason("app")]).toEqual([true, true, "It has threads on the cloud brain."]);
  expect(screen.queryByText("Not a Git repository.")).toBeNull();
  fireEvent.click(toggle("app"));
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.project", expect.anything());
});

it("says quietly when a project is on its way, when the brain kept its own commits, and why a send failed", async () => {
  show([project("p1", "app", { on: true, sending: true }), project("p2", "site", { on: true, kept: true }), project("p3", "docs", { on: true, error: "The brain did not answer import-project." })]);
  expect(await screen.findByText("Sending")).toBeTruthy();
  expect(screen.getByText("The cloud copy has commits this Mac doesn't, so it wasn't updated.")).toBeTruthy();
  expect(screen.getByText("The brain did not answer import-project.").className).toContain("text-bad");
});

it("shows no projects until the brain is set up", async () => {
  show([project("p1", "app")], { state: "none", error: null });
  await screen.findByRole("button", { name: "Set up" });
  expect(screen.queryByText("Projects")).toBeNull();
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.projects", {});
});

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainProject, CloudBrainStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrain } from "./settings-cloud-brain";
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

const ready: CloudBrainStatus = { state: "ready", service: "vercel", region: "sin1", machine: "awake", claude: [], behind: false, working: null, door: null, threads: 0, error: null };
const project = (id: string, name: string, shown: Partial<CloudBrainProject> = {}): CloudBrainProject => ({ id, name, on: false, blocked: null, sending: false, kept: false, error: null, ...shown });

function show(projects: CloudBrainProject[], status: CloudBrainStatus = ready) {
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    if (method === "cloud.brain.projects") return projects as never;
    if (method === "cloud.brain.cost") return null as never;
    if (method === "cloud.brain.phones") return [] as never;
    if (method === "cloud.brain.project") {
      const { projectId, on } = params as { projectId: string; on: boolean };
      return projects.map((each) => (each.id === projectId ? { ...each, on } : each)) as never;
    }
    if (method === "cloud.brain.signIns")
      return {
        codex: { mode: null, email: null, plan: null, signingIn: false, pending: null, error: null },
        github: { on: false, blocked: null, behind: false },
        push: { has: false, behind: false },
        memory: { has: false, behind: false },
      } as never;
    return status as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudBrain active service="vercel" />
    </QueryClientProvider>,
  );
}

const toggle = (name: string) => screen.getByRole("switch", { name }) as HTMLInputElement;
const reason = (name: string) => toggle(name).closest("[data-tooltip]")?.getAttribute("data-tooltip") ?? null;
const picker = () => screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;

it("lists the projects the brain has with a switch each, and adds another from one picker", async () => {
  show([project("p1", "app"), project("p2", "site", { on: true }), project("p3", "docs")]);
  await screen.findByText("Projects");
  expect(toggle("site").checked).toBe(true);
  expect(screen.queryByRole("switch", { name: "app" })).toBeNull();
  // Each project the brain has keeps its own environment for cloud threads.
  expect(screen.getAllByRole("button", { name: "Environment" })).toHaveLength(1);
  expect([...picker().options].map((option) => option.textContent)).toEqual(["app", "docs"]);
  fireEvent.change(picker(), { target: { value: "p3" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.project", { projectId: "p3", on: true }));
  await waitFor(() => expect(toggle("docs").checked).toBe(true));
  fireEvent.click(toggle("site"));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.project", { projectId: "p2", on: false }));
});

it("offers one it cannot move only as a disabled choice that names why, and keeps a blocked switch as it is", async () => {
  show([project("p1", "notes", { blocked: "Not a Git repository." }), project("p2", "app", { on: true, blocked: "It has threads on the cloud brain." })]);
  await screen.findByText("Projects");
  const notes = [...picker().options].find((option) => option.value === "p1")!;
  expect([notes.disabled, notes.textContent]).toEqual([true, "notes · Not a Git repository."]);
  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  expect([toggle("app").checked, toggle("app").disabled, reason("app")]).toEqual([true, true, "It has threads on the cloud brain."]);
  fireEvent.click(toggle("app"));
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.project", expect.anything());
});

it("asks for the first project with what it is for", async () => {
  show([project("p1", "app"), project("p2", "site")]);
  expect(await screen.findByText("Add a project")).toBeTruthy();
  expect(screen.getByText("Threads you start from your phone work in its copy.")).toBeTruthy();
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

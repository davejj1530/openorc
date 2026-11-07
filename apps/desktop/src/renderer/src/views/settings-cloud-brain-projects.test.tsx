import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainProject, CloudBrainStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrain } from "./settings-cloud-brain";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui")>()),
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => <span data-tooltip={label}>{children}</span>,
}));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  useRouter.setState({ route: { view: "settings", section: "cloud" } });
});

const ready: CloudBrainStatus = { state: "ready", service: "vercel", region: "sin1", machine: "awake", claude: [], behind: false, working: null, door: null, threads: 0, error: null };
const project = (id: string, name: string, shown: Partial<CloudBrainProject> = {}): CloudBrainProject => ({
  id,
  name,
  on: false,
  blocked: null,
  sending: false,
  kept: false,
  error: null,
  branch: null,
  ...shown,
});

/** What the project's .env files hold, as `cloud.env.fromFile` reads them. */
let dotEnv: { files: string[]; entries: { name: string; value: string }[] } = { files: [], entries: [] };

function show(projects: CloudBrainProject[], status: CloudBrainStatus = ready) {
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    if (method === "cloud.brain.projects") return projects as never;
    if (method === "cloud.brain.cost") return null as never;
    if (method === "cloud.brain.phones") return [] as never;
    if (method === "cloud.env") return { projectId: (params as { projectId: string }).projectId, names: [] } as never;
    if (method === "cloud.env.fromFile") return dotEnv as never;
    if (method === "cloud.brain.copy") return { branch: "main", commit: "a1b2c3d", subject: "Fix the login flow", checkedOut: "feature-x" } as never;
    if (method === "cloud.env.set") {
      const { projectId, entries } = params as { projectId: string; entries: { name: string }[] };
      return { projectId, names: entries.map((entry) => entry.name) } as never;
    }
    if (method === "cloud.brain.project") {
      const { projectId, on } = params as { projectId: string; on: boolean };
      projects = projects.map((each) => (each.id === projectId ? { ...each, on } : each));
      return projects as never;
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

const row = (name: string) => screen.getByText(name, { selector: ".settings-field span" }).closest(".settings-field") as HTMLElement;
const remove = (name: string) => within(row(name)).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
const reason = (name: string) => remove(name).closest("[data-tooltip]")?.getAttribute("data-tooltip") ?? null;
const picker = () => screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
const sheet = () => screen.getByRole("dialog");

it("lists the projects the brain has, each with its environment and Remove, and adds another through a sheet that sends its .env along", async () => {
  dotEnv = { files: [".env"], entries: [{ name: "API_URL", value: "https://dev.example" }] };
  show([project("p1", "app"), project("p2", "site", { on: true, branch: "main" }), project("p3", "docs")]);
  await screen.findByText("Projects");
  expect(within(row("site")).getByRole("button", { name: "Environment" })).toBeTruthy();
  expect(within(row("site")).getByText("Follows main")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect([...picker().options].map((option) => option.textContent)).toEqual(["app", "docs"]);
  fireEvent.change(picker(), { target: { value: "p3" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByRole("heading", { name: "Add docs to the cloud brain" })).toBeTruthy();
  const branch = await within(sheet()).findByLabelText("Branch copied");
  expect(branch.textContent).toBe("maina1b2c3dFix the login flow");
  expect(within(sheet()).getByText(/checked out\. Its work stays here until it reaches main\./)).toBeTruthy();
  await waitFor(() =>
    expect(
      within(sheet())
        .getAllByRole("textbox", { name: "Name" })
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["API_URL"]),
  );
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.project", expect.anything());
  fireEvent.click(within(sheet()).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.project", { projectId: "p3", on: true }));
  const calls = vi.mocked(core.call).mock.calls.map(([method]) => method);
  expect(calls.indexOf("cloud.env.set")).toBeLessThan(calls.indexOf("cloud.brain.project"));
  expect(core.call).toHaveBeenCalledWith("cloud.env.set", { projectId: "p3", entries: [{ name: "API_URL", value: "https://dev.example" }] });
  await waitFor(() => expect(remove("docs")).toBeTruthy());
  fireEvent.click(remove("site"));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.project", { projectId: "p2", on: false }));
});

it("names why a project cannot be added once its sheet is open, and waits", async () => {
  show([project("p1", "app")]);
  const before = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    if (method === "cloud.brain.copy") throw new Error("No commits on main.");
    return before(method as never, params as never);
  });
  await screen.findByText("Projects");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  // Reads are tried twice before they fail.
  expect(await within(await screen.findByRole("dialog")).findByText("No commits on main.", {}, { timeout: 4000 })).toBeTruthy();
  expect((within(sheet()).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(sheet()).queryByLabelText("Branch copied")).toBeNull();
});

it("adds a project whose .env files hold nothing without saving an environment", async () => {
  dotEnv = { files: [], entries: [] };
  show([project("p1", "app")]);
  await screen.findByText("Projects");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByRole("heading", { name: "Add app to the cloud brain" });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.env.fromFile", { projectId: "p1" }));
  expect(within(sheet()).queryByText("This project has no .env or .env.local.")).toBeNull();
  fireEvent.click(within(sheet()).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.project", { projectId: "p1", on: true }));
  expect(core.call).not.toHaveBeenCalledWith("cloud.env.set", expect.anything());
});

it("offers one it cannot move only as a disabled choice that names why, and keeps a Remove that would cut threads short disabled", async () => {
  show([project("p1", "notes", { blocked: "Not a Git repository." }), project("p2", "app", { on: true, blocked: "It has threads on the cloud brain." })]);
  await screen.findByText("Projects");
  const notes = [...picker().options].find((option) => option.value === "p1")!;
  expect([notes.disabled, notes.textContent]).toEqual([true, "notes · Not a Git repository."]);
  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  expect([remove("app").disabled, reason("app")]).toEqual([true, "It has threads on the cloud brain."]);
  fireEvent.click(remove("app"));
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.project", expect.anything());
});

it("opens the sheet for the project a new thread's Cloud choice asked to add, once", async () => {
  dotEnv = { files: [], entries: [] };
  useRouter.setState({ route: { view: "settings", section: "cloud", project: "p3" } });
  show([project("p1", "app"), project("p2", "site", { on: true }), project("p3", "docs")]);
  expect(await screen.findByRole("heading", { name: "Add docs to the cloud brain" })).toBeTruthy();
  fireEvent.click(within(sheet()).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("dialog")).toBeNull();
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

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedEnvironment, HostedEnvironmentSave } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { ProjectEnvironmentDialog } from "./ProjectEnvironmentDialog";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const close = vi.fn();
const project = { key: "api", name: "api", repo: "example/api", localProjectId: "api", hostedProjectId: "server-api", connected: true };
let environment: HostedEnvironment;
let file: { files: string[]; entries: { name: string; value: string }[] };
let save: (variables: { name: string; value: string }[]) => HostedEnvironmentSave;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  environment = { state: "ready", variables: [], canChange: true };
  file = { files: [".env"], entries: [{ name: "DATABASE_URL", value: "postgres://localhost/api" }] };
  save = (variables) => ({ state: "saved", canChange: true, variables: variables.map(({ name }) => ({ name, updatedAt: 1 })) });
  mock.call.mockImplementation(async (method, params) => {
    if (method === "hostedEnvironment.read") return environment;
    if (method === "hostedEnvironment.fromFile") return file;
    if (method === "hostedEnvironment.set") return save(params["variables"] as { name: string; value: string }[]);
    if (method === "hostedEnvironment.remove") return environment;
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function show(local: string | null = "api") {
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectEnvironmentDialog spaceId="birch" project={{ ...project, localProjectId: local }} onClose={close} />
    </QueryClientProvider>,
  );
}
const calls = (method: string) => mock.call.mock.calls.filter(([called]) => called === method).map(([, params]) => params);
const saveButton = () => screen.getByRole("button", { name: "Save" });

it("opens a project with nothing saved on one empty row, reading no .env until the person asks", async () => {
  show();
  const name = await screen.findByLabelText("Name");
  expect(name).toHaveProperty("value", "");
  expect(screen.getAllByLabelText("Name")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Environment of api" })).toBeTruthy();
  expect(saveButton()).toHaveProperty("disabled", true);
  expect(calls("hostedEnvironment.fromFile")).toEqual([]);
});

it("fills from this Mac's .env on the person's press, and saves what it shows", async () => {
  show();
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByRole("button", { name: "Fill from .env" }));
  expect(await screen.findByDisplayValue("DATABASE_URL")).toBeTruthy();
  expect(screen.getAllByLabelText("Name")).toHaveLength(1);
  expect(calls("hostedEnvironment.fromFile")).toEqual([{ localProjectId: "api" }]);
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(calls("hostedEnvironment.set")).toEqual([{ spaceId: "birch", projectId: "server-api", variables: [{ name: "DATABASE_URL", value: "postgres://localhost/api" }] }]);
});

it("shows saved variables by name with no value, sends only a value typed over one, and removes one taken out", async () => {
  environment = {
    state: "ready",
    canChange: true,
    variables: [
      { name: "APP_MODE", updatedAt: 1 },
      { name: "DATABASE_URL", updatedAt: 1 },
    ],
  };
  show();
  const value = await screen.findByLabelText("Value of DATABASE_URL");
  expect(value.getAttribute("placeholder")).toBe("Saved");
  expect(calls("hostedEnvironment.fromFile")).toEqual([]);
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.change(value, { target: { value: "postgres://elsewhere/api" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove APP_MODE" }));
  fireEvent.click(saveButton());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(calls("hostedEnvironment.set")).toEqual([{ spaceId: "birch", projectId: "server-api", variables: [{ name: "DATABASE_URL", value: "postgres://elsewhere/api" }] }]);
  expect(calls("hostedEnvironment.remove")).toEqual([{ spaceId: "birch", projectId: "server-api", name: "APP_MODE" }]);
});

it("puts a refused name's sentence under its row, keeps the sheet open, and holds Save until the name changes", async () => {
  save = () => ({ state: "refused", name: "ANTHROPIC_API_KEY", message: "ANTHROPIC_ names are kept for the agents." });
  file = { files: [".env"], entries: [{ name: "ANTHROPIC_API_KEY", value: "example-key-value" }] };
  show();
  await screen.findByLabelText("Name");
  fireEvent.click(screen.getByRole("button", { name: "Fill from .env" }));
  await screen.findByDisplayValue("ANTHROPIC_API_KEY");
  fireEvent.click(saveButton());
  expect((await screen.findByRole("alert")).textContent).toBe("ANTHROPIC_ names are kept for the agents.");
  expect(close).not.toHaveBeenCalled();
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByDisplayValue("ANTHROPIC_API_KEY"), { target: { value: "MODEL_KEY" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(saveButton()).toHaveProperty("disabled", false);
});

it("adds a variable by hand, and fills from .env over what is typed", async () => {
  file = { files: [], entries: [] };
  show();
  const name = await screen.findByLabelText("Name");
  fireEvent.change(name, { target: { value: "APP_MODE" } });
  fireEvent.change(screen.getByLabelText("Value of APP_MODE"), { target: { value: "dev" } });
  fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
  expect(screen.getAllByLabelText("Name")).toHaveLength(2);
  file = { files: [".env"], entries: [{ name: "APP_MODE", value: "staging" }] };
  fireEvent.click(screen.getByRole("button", { name: "Fill from .env" }));
  await waitFor(() => expect(screen.getByLabelText("Value of APP_MODE")).toHaveProperty("value", "staging"));
});

it("offers no .env for a project that isn't on this Mac", async () => {
  show(null);
  await screen.findByLabelText("Name");
  expect(screen.queryByRole("button", { name: "Fill from .env" })).toBeNull();
  expect(calls("hostedEnvironment.fromFile")).toEqual([]);
});

it("shows a member the names only, nothing to change, and why Save is held", async () => {
  environment = { state: "ready", canChange: false, variables: [{ name: "DATABASE_URL", updatedAt: 1 }] };
  show();
  const name = await screen.findByDisplayValue("DATABASE_URL");
  expect(name).toHaveProperty("readOnly", true);
  expect(screen.queryByRole("button", { name: "Remove DATABASE_URL" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add variable" })).toBeNull();
  expect(saveButton()).toHaveProperty("disabled", true);
  expect(saveButton().parentElement?.getAttribute("data-tip")).toBe("Only an admin can change a project's environment.");
});

it("shows a failed read as the failure, with a way to try again", async () => {
  mock.call.mockImplementation(async () => {
    throw new Error("OpenOrc Cloud can't be reached.");
  });
  show();
  // The read is asked once more before it fails.
  expect(await screen.findByText("OpenOrc Cloud can't be reached.", {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

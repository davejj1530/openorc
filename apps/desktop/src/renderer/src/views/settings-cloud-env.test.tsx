import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { CloudEnvButton } from "./settings-cloud-env";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

function show(names: string[], file: { files: string[]; entries: { name: string; value: string }[] } = { files: [], entries: [] }) {
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    const { projectId } = params as { projectId: string };
    if (method === "cloud.env") return { projectId, names } as never;
    if (method === "cloud.env.fromFile") return file as never;
    if (method === "cloud.env.set") return { projectId, names: (params as { entries: { name: string }[] }).entries.map((entry) => entry.name).sort() } as never;
    throw new Error(`unexpected ${method}`);
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudEnvButton project={{ id: "p1", name: "app" }} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Environment" }));
}

const names = () => screen.getAllByRole("textbox", { name: "Name" }).map((input) => (input as HTMLInputElement).value);
const value = (name: string) => screen.getByLabelText(`Value of ${name}`) as HTMLInputElement;

it("shows the saved names with their values hidden, and keeps a saved value left empty", async () => {
  show(["API_URL", "DEBUG"]);
  await waitFor(() => expect(names()).toEqual(["API_URL", "DEBUG"]));
  expect([value("API_URL").value, value("API_URL").placeholder, value("API_URL").type]).toEqual(["", "Saved", "password"]);
  fireEvent.change(value("DEBUG"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove API_URL" }));
  fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
  fireEvent.change(screen.getAllByRole("textbox", { name: "Name" }).at(-1)!, { target: { value: "TOKEN" } });
  fireEvent.change(value("TOKEN"), { target: { value: "dev-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(core.call).toHaveBeenCalledWith("cloud.env.set", {
      projectId: "p1",
      entries: [
        { name: "DEBUG", value: "1" },
        { name: "TOKEN", value: "dev-token" },
      ],
    }),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
});

it("sends a saved name it did not touch without a value, so the saved one stays", async () => {
  show(["API_URL"]);
  await waitFor(() => expect(names()).toEqual(["API_URL"]));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.env.set", { projectId: "p1", entries: [{ name: "API_URL" }] }));
});

it("asks for a value again once a saved name is changed, since the saved one belongs to the old name", async () => {
  show(["API_URL"]);
  await waitFor(() => expect(names()).toEqual(["API_URL"]));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "API_BASE" } });
  expect(value("API_BASE").placeholder).toBe("Value");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.env.set", { projectId: "p1", entries: [{ name: "API_BASE", value: "" }] }));
});

it("fills from the project's .env files over what is there, and says when it has none", async () => {
  show(["API_URL"], {
    files: [".env"],
    entries: [
      { name: "API_URL", value: "https://dev.example" },
      { name: "NEW_KEY", value: "n" },
    ],
  });
  await waitFor(() => expect(names()).toEqual(["API_URL"]));
  fireEvent.click(screen.getByRole("button", { name: "Fill from .env" }));
  await waitFor(() => expect(names()).toEqual(["API_URL", "NEW_KEY"]));
  expect(value("API_URL").value).toBe("https://dev.example");
  cleanup();
  queryClient.clear();
  show([]);
  await waitFor(() => expect(names()).toEqual([""]));
  fireEvent.click(screen.getByRole("button", { name: "Fill from .env" }));
  expect(await screen.findByText("This project has no .env or .env.local.")).toBeTruthy();
});

it("shows why a save was refused and stays open", async () => {
  show(["API_URL"]);
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.env") return { projectId: "p1", names: ["API_URL"] } as never;
    throw new Error("PATH is set by the sandbox for every turn.");
  });
  await waitFor(() => expect(names()).toEqual(["API_URL"]));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("PATH is set by the sandbox for every turn.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});

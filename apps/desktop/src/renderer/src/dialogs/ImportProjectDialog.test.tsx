import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { useRouter } from "../lib/router";
import { ImportProjectDialog } from "./ImportProjectDialog";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));

const missingFolder = "/Users/you/dev/new-app";
const existingFolder = "/Users/you/dev/app";
const onOpenChange = vi.fn();
beforeEach(() => {
  useRouter.setState({ route: { view: "newthread" }, history: [], future: [] });
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    const { rootPath } = params as { rootPath: string };
    if (method === "projects.folderMissing") return rootPath === missingFolder;
    if (method === "projects.import") return { id: `project:${rootPath}`, rootPath } as Project;
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <ImportProjectDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}
const typeFolder = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });
const importCalls = () => vi.mocked(core.call).mock.calls.filter(([method]) => method === "projects.import");

async function importMissingFolder() {
  show();
  typeFolder(missingFolder);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText("This folder doesn’t exist yet.");
}

it("asks before creating a folder that does not exist, and an edited path imports again", async () => {
  await importMissingFolder();
  expect(core.call).toHaveBeenCalledWith("projects.folderMissing", { rootPath: missingFolder });
  expect(screen.getByRole("button", { name: "Create and import" })).toBeTruthy();
  expect(importCalls()).toEqual([]);
  typeFolder(`${missingFolder}-2`);
  expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
  expect(screen.queryByText("This folder doesn’t exist yet.")).toBeNull();
});

it("creates and imports the missing folder on the second press, then opens the project", async () => {
  await importMissingFolder();
  fireEvent.click(screen.getByRole("button", { name: "Create and import" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(importCalls()).toEqual([["projects.import", { rootPath: missingFolder, create: true }]]);
  expect(useRouter.getState().route).toEqual({ view: "project", projectId: `project:${missingFolder}` });
});

it("imports anyway when the folder check fails, so the import's error explains the problem", async () => {
  vi.mocked(core.call).mockRejectedValue(new Error("OpenOrc is restarting to update. Please wait."));
  show();
  typeFolder(missingFolder);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(await screen.findByText("OpenOrc is restarting to update. Please wait.")).toBeTruthy();
  expect(importCalls()).toEqual([["projects.import", { rootPath: missingFolder, create: false }]]);
});

it("imports an existing folder at once without creating anything", async () => {
  show();
  typeFolder(` ${existingFolder} `);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(importCalls()).toEqual([["projects.import", { rootPath: existingFolder, create: false }]]);
  expect(screen.queryByText("This folder doesn’t exist yet.")).toBeNull();
});

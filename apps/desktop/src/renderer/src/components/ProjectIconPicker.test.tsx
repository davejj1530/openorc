import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectIconState, ProjectIconsApi } from "../../../shared/project-icons";
import { ProjectIconPicker } from "./ProjectIconPicker";

vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
const icon = { path: "public/icon.png", dataUrl: "data:image/png;base64,cHJldmlldw==" };
const state: ProjectIconState = { mode: "auto", selected: icon, candidates: [icon], fallback: "react" };
let api: ProjectIconsApi;
let client: QueryClient;
beforeEach(() => {
  api = {
    get: vi.fn(async () => state),
    refresh: vi.fn(async () => state),
    choose: vi.fn(async (): Promise<ProjectIconState> => ({ ...state, mode: "folder", selected: null })),
    pick: vi.fn(async () => null),
    onChanged: vi.fn(() => () => {}),
  };
  Object.defineProperty(window, "openorc", { value: { projectIcons: api }, configurable: true, writable: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show() {
  return render(
    <QueryClientProvider client={client}>
      <ProjectIconPicker rootPath="/repo" name="Studio" />
    </QueryClientProvider>,
  );
}

it("shares a cached query across rerenders and remounts without polling or refreshing", async () => {
  const first = show();
  await waitFor(() => expect(first.container.querySelector("img")?.getAttribute("src")).toBe(icon.dataUrl));
  first.unmount();
  const second = show();
  await waitFor(() => expect(second.container.querySelector("img")).not.toBeNull());
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.refresh).not.toHaveBeenCalled();
});

it("opens a keyboard accessible chooser and applies the folder fallback", async () => {
  const view = show();
  await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Choose icon for Studio" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use folder" }));
  await waitFor(() => expect(api.choose).toHaveBeenCalledWith("/repo", { mode: "folder" }));
  await waitFor(() => expect(view.container.querySelector("img")).toBeNull());
});

it("chooses repository candidates and refreshes only on request", async () => {
  api.choose = vi.fn(async (): Promise<ProjectIconState> => ({ ...state, mode: "manual" }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Choose icon for Studio" }));
  const refresh = await screen.findByRole("button", { name: "Refresh" });
  await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
  fireEvent.click(refresh);
  await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use public/icon.png" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Use public/icon.png" }));
  await waitFor(() => expect(api.choose).toHaveBeenCalledWith("/repo", { mode: "manual", path: icon.path }));
});

it("keeps the current icon when the file picker is cancelled and displays failures", async () => {
  const view = show();
  fireEvent.click(screen.getByRole("button", { name: "Choose icon for Studio" }));
  const choose = await screen.findByRole("button", { name: "Choose file…" });
  await waitFor(() => expect(choose.hasAttribute("disabled")).toBe(false));
  fireEvent.click(choose);
  await waitFor(() => expect(api.pick).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe(icon.dataUrl);
  api.refresh = vi.fn(async () => {
    throw Error("Folder unavailable");
  });
  await waitFor(() => expect(choose.hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Folder unavailable");
});

it("shows the detected framework only when automatic has no repository image", async () => {
  api.get = vi.fn(async (): Promise<ProjectIconState> => ({ ...state, selected: null, candidates: [], fallback: "nestjs" }));
  const view = show();
  await waitFor(() => expect(view.container.querySelector('[data-project-stack="nestjs"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Choose icon for Studio" }));
  expect((await screen.findByText(/Detected NestJS/)).textContent).toContain("Automatic");
  fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
  await waitFor(() => expect(view.container.querySelector("[data-project-stack]")).toBeNull());
  expect(view.container.querySelector('[data-icon="Folder"]')).not.toBeNull();
});

it("prioritizes repository and manual images over the detected framework", async () => {
  const view = show();
  await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
  expect(view.container.querySelector("[data-project-stack]")).toBeNull();
  api.choose = vi.fn(async (): Promise<ProjectIconState> => ({ ...state, mode: "manual" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose icon for Studio" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use public/icon.png" }));
  await waitFor(() => expect(api.choose).toHaveBeenCalled());
  expect(view.container.querySelector("[data-project-stack]")).toBeNull();
});

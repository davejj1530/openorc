import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { spaceNavigation } from "../lib/space-navigation";
import { useUi } from "../lib/ui";
import { OrganizationAddProject } from "./OrganizationAddProject";

const mock = vi.hoisted(() => ({ call: vi.fn(), role: "admin" }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
beforeEach(() => {
  queryClient.clear();
  spaceNavigation.setState({ key: null, current: null, personal: null, inventory: [], views: {} });
  useUi.getState().setImportProject(false);
  mock.role = "admin";
  mock.call.mockImplementation(async (method) =>
    method === "spaces.status" ? { state: "ready", spaces: [{ id: "birch", kind: "organization", role: mock.role }] } : { configured: false, installations: [], repositories: [] },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationAddProject />
    </QueryClientProvider>,
  );
}
it("keeps the existing local import in Personal and signed out", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));
  expect(useUi.getState().importProject).toBe(true);
});
it("opens the organization's repository picker for an admin", async () => {
  spaceNavigation.setState({ current: "birch", personal: "personal" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
  await screen.findByRole("dialog", { name: "Add projects" });
  expect(mock.call).toHaveBeenCalledWith("organization.repositories", { spaceId: "birch" });
  expect(useUi.getState().importProject).toBe(false);
});
it("offers no Add project control to a member", async () => {
  mock.role = "member";
  spaceNavigation.setState({ current: "birch", personal: "personal" });
  show();
  await queryClient.fetchQuery({ queryKey: ["spaces.status", {}], queryFn: () => mock.call("spaces.status", {}) });
  expect(screen.queryByRole("button", { name: "Add project" })).toBeNull();
});

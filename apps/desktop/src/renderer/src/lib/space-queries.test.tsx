import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OrganizationAccess, SpacesStatus } from "@openorc/protocol";
import { queryClient } from "./client";
import { organizationContentGate } from "./organization-content-gate";
import { spaceNavigation } from "./space-navigation";
import { useSpaceProjects, useSpaceRpc, useSpaceThread } from "./space-queries";

const pending = vi.hoisted(() => new Map<string, (count: unknown) => void>());
vi.mock("./rpc", () => ({
  core: {
    onPush: () => () => {},
    call: vi.fn((_method: string, params: { spaceId: string; ownership: string }) => new Promise<unknown>((resolve) => pending.set(`${params.spaceId}:${params.ownership}`, resolve))),
  },
}));

afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  spaceNavigation.getState().end();
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
  pending.clear();
});

function Count() {
  const count = useSpaceRpc("threads.resolvedCount", { projectIds: [], quietBefore: 1 });
  return <p>{count.data ?? "Loading"}</p>;
}

it("keeps delayed counts in their requested space and ownership filter", async () => {
  spaceNavigation.getState().initialize("account", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "birch", personal: false, projects: [], threads: [], taskIds: [] },
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <Count />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(pending.has("personal:everyone")).toBe(true));
  act(() => spaceNavigation.getState().select("birch"));
  await waitFor(() => expect(pending.has("birch:everyone")).toBe(true));
  await act(async () => pending.get("birch:everyone")!(2));
  await screen.findByText("2");
  await act(async () => pending.get("personal:everyone")!(9));
  expect(screen.queryByText("9")).toBeNull();
  act(() => spaceNavigation.getState().setOwnership("mine"));
  await screen.findByText("Loading");
  await waitFor(() => expect(pending.has("birch:mine")).toBe(true));
  await act(async () => pending.get("birch:mine")!(1));
  await screen.findByText("1");
  act(() => spaceNavigation.getState().select("personal"));
  await screen.findByText("9");
});

const frozen: OrganizationAccess = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." };
const active: OrganizationAccess = { state: "active", reason: null, until: null, message: null };
async function hear(access: OrganizationAccess) {
  const status: SpacesStatus = {
    state: "ready",
    userId: "person",
    apiOrigin: "https://cloud.example.com",
    personalSpaceId: "personal",
    spaces: [
      { kind: "personal", id: "personal" },
      { kind: "organization", id: "birch", name: "Birch", logo: null, memberId: "member", role: "member", memberCount: 2 },
    ],
    create: { allowed: true, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    error: null,
    organizationAccess: access,
  };
  pending.delete("undefined:undefined");
  const read = organizationContentGate.refresh();
  pending.get("undefined:undefined")!({ ...status, heardAt: Date.now() });
  await act(async () => read);
}
function inBirch() {
  spaceNavigation.getState().initialize("account", "personal", [
    { id: "personal", personal: true, projects: [], threads: [], taskIds: [] },
    { id: "birch", personal: false, projects: [], threads: [{ id: "plan", projectId: "atlas", title: "Hiring plan", owner: { brain: "hosted", reach: "live", heardAt: 1 } }], taskIds: [] },
  ]);
  spaceNavigation.getState().select("birch");
}
const countKey = ["threads.resolvedCount", { projectIds: [], quietBefore: 1, spaceId: "birch", ownership: "everyone" }];

it("asks a frozen organization nothing, and holds back what a late answer left in the cache", async () => {
  inBirch();
  await hear(frozen);
  pending.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <Count />
    </QueryClientProvider>,
  );
  await screen.findByText("Loading");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect([...pending.keys()]).toEqual([]);
  act(() => void queryClient.setQueryData(countKey, 7));
  expect(screen.queryByText("7")).toBeNull();
  queryClient.removeQueries({ queryKey: countKey });
  await hear(active);
  await waitFor(() => expect(pending.has("birch:everyone")).toBe(true));
});

function Thread() {
  const thread = useSpaceThread("plan");
  const projects = useSpaceProjects();
  return (
    <p>
      {thread.data === null ? "No thread" : "Thread"} {thread.knownTitle ?? "untitled"} {projects.data ? "projects" : "no projects"}
    </p>
  );
}

it("gives a frozen person no thread, title or project list of the organization", async () => {
  inBirch();
  queryClient.setQueryData(["threads.get", { id: "plan" }], { id: "plan", title: "Hiring plan" });
  queryClient.setQueryData(["spaces.projects", { spaceId: "birch" }], []);
  queryClient.setQueryData(["projects.list", {}], []);
  await hear(frozen);
  pending.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <Thread />
    </QueryClientProvider>,
  );
  await screen.findByText("No thread untitled no projects");
  expect([...pending.keys()]).toEqual([]);
});

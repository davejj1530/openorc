import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { OrganizationAccess, SpaceProject, SpacesStatus } from "@openorc/protocol";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "./client";
import { organizationContentGate } from "./organization-content-gate";
import { useOrganizationController } from "./organization-controller";
import { spaceNavigation } from "./space-navigation";
import { useUi } from "./ui";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: { spaceId?: string }) => Promise<unknown>>() }));
vi.mock("./rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));

const active: OrganizationAccess = { state: "active", reason: null, until: null, message: null };
const frozen: OrganizationAccess = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." };
const cloud = { brain: "hosted" as const, reach: "live" as const, heardAt: 1 };
const projects: SpaceProject[] = [{ key: "cloud:atlas", name: "Atlas", repo: "example/atlas", localProjectId: null, hostedProjectId: "atlas", connected: true }];
let access: OrganizationAccess;
let role: "admin" | "member";
const status = (): SpacesStatus => ({
  state: "ready",
  userId: "person",
  apiOrigin: "https://cloud.example.com",
  personalSpaceId: "personal",
  spaces: [
    { kind: "personal", id: "personal" },
    { kind: "organization", id: "birch", name: "Birch", logo: null, memberId: "member", role, memberCount: 2 },
  ],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: Date.now(),
  error: null,
  organizationAccess: access,
});
beforeEach(() => {
  access = active;
  role = "admin";
  mock.call.mockImplementation(async (method, params) => {
    if (method === "spaces.status" || method === "spaces.refresh") return status();
    if (method === "account.status") return { state: "signed-in", email: "person@example.com", name: "Person" };
    if (method === "system.info") return { dataDir: "/profile" };
    if (params.spaceId !== "birch") return [];
    if (method === "spaces.projects") return projects;
    return method === "threads.list" ? [{ id: "plan", projectId: "cloud:atlas", owner: cloud, title: "Hiring plan" }] : [];
  });
});
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  if (spaceNavigation.getState().key) spaceNavigation.getState().end();
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
const birch = () => spaceNavigation.getState().inventory.find((space) => space.id === "birch");
const asked = (spaceId: string, method: string) => mock.call.mock.calls.filter(([name, params]) => name === method && params.spaceId === spaceId).length;
async function inBirch() {
  const hook = renderHook(() => useOrganizationController(), { wrapper });
  await waitFor(() => expect(birch()?.threads).toHaveLength(1));
  act(() => hook.result.current.actions.select("birch"));
  await waitFor(() => expect(hook.result.current.actions.organization?.id).toBe("birch"));
  return hook;
}
/** The gate hears the server again, as it does on focus or a pushed change. */
const hear = () => act(() => organizationContentGate.refresh());

it("empties the organization and reads the spaces again when the person is frozen, asking the organization nothing", async () => {
  await inBirch();
  queryClient.setQueryData(["threads.get", { id: "plan" }], { id: "plan", title: "Hiring plan" });
  useUi.getState().setPalette(true);
  const before = { personal: asked("personal", "spaces.projects"), birch: asked("birch", "spaces.projects") };
  access = frozen;
  await hear();
  expect(birch()).toMatchObject({ closed: true, threads: [], projects: [] });
  expect(queryClient.getQueryData(["threads.get", { id: "plan" }])).toBeUndefined();
  expect(useUi.getState().palette).toBe(false);
  await waitFor(() => expect(asked("personal", "spaces.projects")).toBeGreaterThan(before.personal));
  expect(asked("birch", "spaces.projects")).toBe(before.birch);
});

it("reads the organization fresh when access returns", async () => {
  access = frozen;
  const hook = renderHook(() => useOrganizationController(), { wrapper });
  await waitFor(() => expect(birch()?.closed).toBe(true));
  expect(asked("birch", "threads.list")).toBe(0);
  expect(hook.result.current.actions.organization).toBeNull();
  access = active;
  await hear();
  await waitFor(() => expect(birch()?.threads).toEqual([{ id: "plan", projectId: "cloud:atlas", owner: cloud, title: "Hiring plan" }]));
  expect(birch()?.closed).toBeUndefined();
});

it("closes Add projects when the person is frozen and does not open it again, while a frozen admin can still invite", async () => {
  const hook = await inBirch();
  act(() => hook.result.current.actions.addProjects());
  expect(hook.result.current.actions.dialog).toEqual({ kind: "projects", spaceId: "birch" });
  access = frozen;
  await hear();
  expect(hook.result.current.actions.dialog).toBeNull();
  act(() => hook.result.current.actions.addProjects());
  expect(hook.result.current.actions.dialog).toBeNull();
  act(() => hook.result.current.actions.invite());
  expect(hook.result.current.actions.dialog?.kind).toBe("invite");
});

it("closes an admin's dialog when they are made a member", async () => {
  const hook = await inBirch();
  act(() => hook.result.current.actions.invite());
  expect(hook.result.current.actions.dialog?.kind).toBe("invite");
  role = "member";
  await act(async () => {
    queryClient.setQueryData(["spaces.status", {}], status());
  });
  await waitFor(() => expect(hook.result.current.actions.dialog).toBeNull());
});

it("asks the organization nothing more once the person signs out", async () => {
  await inBirch();
  const before = asked("birch", "spaces.projects") + asked("birch", "threads.list") + asked("birch", "tasks.list");
  mock.call.mockImplementation(async (method, params) => {
    if (method === "spaces.status" || method === "spaces.refresh") return { state: "signed-out" };
    if (method === "account.status") return { state: "signed-out", signingIn: null, ended: false, error: null };
    if (method === "system.info") return { dataDir: "/profile" };
    if (params.spaceId === "birch") throw new Error("You're not in this organization.");
    return [];
  });
  // The core says the account and its spaces changed, as it does at sign out.
  await act(async () => {
    await organizationContentGate.refresh();
    await queryClient.invalidateQueries();
  });
  await waitFor(() => expect(spaceNavigation.getState().key).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(asked("birch", "spaces.projects") + asked("birch", "threads.list") + asked("birch", "tasks.list")).toBe(before);
});

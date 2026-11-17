import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpaceProject, SpacesStatus } from "@openorc/protocol";
import { organizationContentGate } from "./organization-content-gate";
import { core } from "./rpc";
import { spaceNavigation } from "./space-navigation";
import { reconcileSpaceNavigation } from "./space-queries";

beforeEach(() => {
  vi.spyOn(core, "call").mockResolvedValue([]);
});

const status: Extract<SpacesStatus, { state: "ready" }> = {
  state: "ready",
  userId: "person",
  apiOrigin: "https://cloud.example.com",
  personalSpaceId: "personal",
  spaces: [
    { kind: "personal", id: "personal" },
    { kind: "organization", id: "birch", name: "Birch", logo: null, memberId: "member", role: "admin", memberCount: 1 },
  ],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};

afterEach(() => {
  organizationContentGate.reset();
  spaceNavigation.getState().end();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it("waits for a superseding read before an explicit opening selects the new organization", async () => {
  const first = Promise.withResolvers<SpaceProject[]>();
  const second = Promise.withResolvers<SpaceProject[]>();
  vi.mocked(core.call).mockResolvedValue([]).mockReturnValueOnce(first.promise).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(second.promise);
  let opened = false;
  const opening = reconcileSpaceNavigation(status, "core").then(() => {
    opened = true;
    spaceNavigation.getState().select("birch");
  });
  const background = reconcileSpaceNavigation(status, "core");
  first.resolve([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(false);
  second.resolve([]);
  await Promise.all([opening, background]);
  expect(spaceNavigation.getState().current).toBe("birch");
});

it("opens Personal with its cloud projects for an account with no organization", async () => {
  const site: SpaceProject = { key: "cloud:site", name: "site", repo: "acme/site", localProjectId: null, hostedProjectId: "site", connected: true };
  vi.mocked(core.call).mockImplementation(((method: string) => Promise.resolve(method === "spaces.projects" ? [site] : [])) as typeof core.call);
  await reconcileSpaceNavigation({ ...status, spaces: [{ kind: "personal", id: "personal" }] }, "core");
  expect(spaceNavigation.getState()).toMatchObject({ current: "personal", personal: "personal" });
  expect(spaceNavigation.getState().inventory.map((space) => space.projects)).toEqual([[site]]);
});

const frozenAccess = { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to use an organization. Open Account or ask an admin for a seat." } as const;
const activeAccess = { state: "active", reason: null, until: null, message: null } as const;
const cloud = { brain: "hosted" as const, reach: "live" as const, heardAt: 1 };
const birchProjects: SpaceProject[] = [{ key: "cloud:atlas", name: "Atlas", repo: "example/atlas", localProjectId: null, hostedProjectId: "atlas", connected: true }];
const birchThreads = [{ id: "plan", projectId: "cloud:atlas", owner: cloud, title: "Hiring plan" }];
const birchContent: Record<string, unknown> = { "spaces.projects": birchProjects, "threads.list": birchThreads };
/** The core as the gate and the reconciliation both ask it; `content` answers an organization's reads. */
function answers(access: typeof frozenAccess | typeof activeAccess, content: (method: string) => unknown = (method) => birchContent[method] ?? []) {
  const heard = () => ({ ...status, organizationAccess: access, heardAt: Date.now() });
  vi.mocked(core.call).mockImplementation(((method: string, params: { spaceId?: string }) => {
    if (method === "spaces.refresh") return Promise.resolve(heard());
    return Promise.resolve(params.spaceId === "birch" ? content(method) : []);
  }) as typeof core.call);
  return heard;
}
const asked = (spaceId: string) =>
  vi
    .mocked(core.call)
    .mock.calls.filter(([, params]) => (params as { spaceId?: string }).spaceId === spaceId)
    .map(([method]) => method);
const birch = () => spaceNavigation.getState().inventory.find((space) => space.id === "birch");

it("asks a frozen organization for nothing and keeps it in the switcher", async () => {
  const heard = answers(frozenAccess);
  await organizationContentGate.refresh();
  await reconcileSpaceNavigation(heard(), "core");
  expect(asked("birch")).toEqual([]);
  expect(asked("personal")).toEqual(["spaces.projects", "threads.list", "tasks.list"]);
  expect(birch()).toMatchObject({ id: "birch", accountId: "person", personal: false, projects: [], threads: [], taskIds: [], closed: true });
});

it("lists a person who joined without Pro in their organization even when its content is refused", async () => {
  const heard = answers(frozenAccess, () => {
    throw new Error("You need Pro to use this organization. Open Account or ask an admin for a seat.");
  });
  await organizationContentGate.refresh();
  await reconcileSpaceNavigation(heard(), "core");
  expect(spaceNavigation.getState().inventory.map((space) => space.id)).toEqual(["personal", "birch"]);
});

it("never shows what a read brought back after the person was frozen", async () => {
  const late = Promise.withResolvers<unknown>();
  const heard = answers(activeAccess, (method) => (method === "threads.list" ? late.promise : (birchContent[method] ?? [])));
  await organizationContentGate.refresh();
  const reading = reconcileSpaceNavigation(heard(), "core");
  await new Promise((resolve) => setTimeout(resolve, 0));
  answers(frozenAccess);
  await organizationContentGate.refresh();
  late.resolve(birchThreads);
  await reading;
  expect(birch()).toMatchObject({ closed: true, projects: [], threads: [] });
  expect(JSON.stringify(spaceNavigation.getState().inventory)).not.toMatch(/Hiring plan|Atlas/);
});

it("reads an organization again, fresh, once access is back", async () => {
  const heard = answers(frozenAccess);
  await organizationContentGate.refresh();
  await reconcileSpaceNavigation(heard(), "core");
  const open = answers(activeAccess);
  await organizationContentGate.refresh();
  await reconcileSpaceNavigation(open(), "core");
  expect(asked("birch")).toEqual(["spaces.projects", "threads.list", "tasks.list"]);
  expect(birch()).toMatchObject({ projects: birchProjects, threads: birchThreads });
  expect(birch()?.closed).toBeUndefined();
});

it("reads everything as before while the gate has not been heard", async () => {
  const heard = answers(activeAccess);
  await reconcileSpaceNavigation(heard(), "core");
  expect(asked("birch")).toEqual(["spaces.projects", "threads.list", "tasks.list"]);
});

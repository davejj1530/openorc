// @vitest-environment jsdom
import type { Space, SpacesStatus, ThreadSummary } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import { useHomeItems } from "../home/use-home-items";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { chooseSpace } from "./space-choice";
import { useSpaces } from "./use-spaces";

const personal: Space = { id: "personal-me", kind: "personal" };
const birch: Space = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "member-me", role: "member", memberCount: 2 };
const ready = (spaces: Space[]): SpacesStatus => ({
  state: "ready",
  userId: "me",
  apiOrigin: "",
  personalSpaceId: personal.id,
  spaces,
  create: { allowed: false, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
});
const today = (id: string, projectId: string, facts: Partial<ThreadSummary> = {}): ThreadSummary => ({ ...fixtureThreads[0]!, id, projectId, lastActivityAt: Date.now() - 1000, ...facts });

/** A Mac whose account a test sets, and every call the phone made of it. */
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, status: null as SpacesStatus | null, calls: [] as { method: string; params: Record<string, unknown> }[] }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, raw) => {
    const params = raw as Record<string, unknown>;
    mac.calls.push({ method, params });
    if (method === "spaces.status") return mac.status;
    if (method === "spaces.projects")
      return params["spaceId"] === birch.id ? [{ key: "canvas", name: "Canvas", repo: "example/canvas", localProjectId: "p-mac", hostedProjectId: "p-cloud", connected: true }] : [];
    if (method === "projects.list") return [];
    if (method === "inbox.list") return { items: [] };
    if (method === "threads.resolvedCount") return 0;
    if (method === "threads.get") return null;
    if (method === "threads.list") {
      if (params["spaceId"] === birch.id)
        return [today("cloud-thread", "p-cloud", { title: "Birch pricing page", owner: { brain: "hosted", reach: "live", heardAt: 1 } }), today("mac-thread", "p-mac")];
      return [today("workspace-thread", fixtureThreads[0]!.projectId)];
    }
    throw new Error(`Unexpected phone call: ${method}`);
  });
  return mac.phone.module;
});

afterEach(() => {
  cleanup();
  mac.status = null;
  mac.calls.length = 0;
  mac.phone!.shared.clear();
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
});

const lists = () => mac.calls.filter((call) => call.method === "threads.list").map((call) => call.params);
/** Each thread with the project it is listed under: its group's label, or the name its row carries outside one. */
const rows = (items: ReturnType<typeof useHomeItems>["items"]) => {
  let group: string | null = null;
  return items.flatMap((item) => {
    if (item.kind === "project") group = item.project.name;
    else if (item.kind === "section") group = null;
    return item.kind === "thread" ? [`${item.thread.id}:${item.project ?? group}`] : [];
  });
};

it("asks a Mac that shares no cloud threads nothing of spaces, and lists that Mac's projects as before", async () => {
  mac.status = ready([personal, birch]);
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(rows(home.result.current.items)).toEqual(["workspace-thread:No project"]));
  expect(mac.calls.filter((call) => call.method.startsWith("spaces."))).toEqual([]);
  expect(lists().every((params) => Array.isArray(params["projectIds"]) && !("spaceId" in params))).toBe(true);
});

it("lists Personal first, then the space the person chooses, every list naming its space and no project of the Mac", async () => {
  mac.phone!.shared.add("cloud-threads");
  mac.status = ready([personal, birch]);
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(lists().some((params) => params["spaceId"] === personal.id)).toBe(true));
  await waitFor(() => expect(rows(home.result.current.items)).toEqual(["workspace-thread:No project"]));

  mac.calls.length = 0;
  act(() => chooseSpace(birch.id));
  await waitFor(() => expect(rows(home.result.current.items).sort()).toEqual(["cloud-thread:Canvas", "mac-thread:Canvas"]));
  expect(lists().length).toBeGreaterThan(0);
  expect(lists().every((params) => params["spaceId"] === birch.id && !("projectIds" in params))).toBe(true);
  // Once the space's projects are known, the count of resolved threads names the Mac's folders among them.
  await waitFor(() =>
    expect(mac.calls.filter((call) => call.method === "threads.resolvedCount").map((call) => call.params)).toContainEqual(expect.objectContaining({ spaceId: birch.id, projectIds: ["p-mac"] })),
  );
});

it("asks a space for the person's own threads once they choose Mine, and leaves out a workspace they unticked", async () => {
  const { chooseOwnership, toggleWorkspace } = await import("../home/filter");
  mac.phone!.shared.add("cloud-threads");
  mac.status = ready([personal, birch]);
  act(() => chooseSpace(birch.id));
  const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(rows(home.result.current.items).sort()).toEqual(["cloud-thread:Canvas", "mac-thread:Canvas"]));
  expect(
    lists()
      .filter((params) => params["spaceId"] === birch.id)
      .every((params) => params["ownership"] === "everyone"),
  ).toBe(true);
  mac.calls.length = 0;
  act(() => chooseOwnership(birch.id, "mine"));
  await waitFor(() => expect(lists().some((params) => params["ownership"] === "mine")).toBe(true));
  act(() => toggleWorkspace(birch.id, "canvas"));
  await waitFor(() => expect(rows(home.result.current.items)).toEqual([]));
  act(() => {
    toggleWorkspace(birch.id, "canvas");
    chooseOwnership(birch.id, "everyone");
  });
});

it("shows Personal again when the space chosen on this phone is no longer the person's", async () => {
  mac.phone!.shared.add("cloud-threads");
  mac.status = ready([personal, birch]);
  const spaces = renderHook(() => useSpaces(), { wrapper: mac.phone!.wrapper });
  act(() => chooseSpace(birch.id));
  await waitFor(() => expect(spaces.result.current).toMatchObject({ state: "ready", current: { id: birch.id } }));
  mac.status = ready([personal]);
  await act(() => mac.phone!.module.queryClient.invalidateQueries({ queryKey: ["spaces.status"] }));
  await waitFor(() => expect(spaces.result.current).toMatchObject({ state: "ready", current: { id: personal.id } }));
});

it("lists the Mac alone while nobody is signed in on it, or it has no account", async () => {
  mac.phone!.shared.add("cloud-threads");
  for (const status of [{ state: "signed-out" }, { state: "unavailable" }] as SpacesStatus[]) {
    mac.status = status;
    mac.calls.length = 0;
    mac.phone!.module.queryClient.clear();
    const home = renderHook(() => useHomeItems(true), { wrapper: mac.phone!.wrapper });
    await waitFor(() => expect(rows(home.result.current.items)).toEqual(["workspace-thread:No project"]));
    expect(lists().every((params) => !("spaceId" in params))).toBe(true);
    home.unmount();
  }
});

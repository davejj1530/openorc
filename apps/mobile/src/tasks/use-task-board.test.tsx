// @vitest-environment jsdom
import type { TaskBoard } from "@openorc/protocol";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTaskBoard } from "./use-task-board";

/** A Mac out of reach whose list the phone kept from a launch before, and its brain, connected, with an older copy. */
const hosts = vi.hoisted(() => ({ mac: null as unknown as QueryClient, brain: null as unknown as QueryClient }));
vi.mock("../client", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  hosts.mac = new QueryClient();
  hosts.brain = new QueryClient();
  const brainBoard: TaskBoard = { tasks: [], mac: { at: 5_000, tasks: [] } };
  const link = (kind: string, board: TaskBoard | null) => {
    const state = { kind };
    return { connection: { device: async () => board }, subscribe: () => () => undefined, getState: () => state };
  };
  const shown = link("waiting", null);
  const partner = link("connected", brainBoard);
  return {
    hostLink: (host: string | null) => (host ? partner : shown),
    hostClient: (host: string | null) => ({ queryClient: host ? hosts.brain : hosts.mac }),
    usePartnerLinkState: () => partner.getState(),
    useHostGroup: () => ({ primary: "mac-1", partner: "brain-1" }),
    useSavedMacs: () => [
      { id: "mac-1", name: "Studio", kind: "mac" },
      { id: "brain-1", name: "Cloud", kind: "brain" },
    ],
  };
});

it("dates the Mac's kept list by when the phone heard it, so a newer one stands in for the brain's older copy", async () => {
  hosts.mac.setQueryData(["tasks.board"], { tasks: [{ id: "task-1", projectId: "p", title: "Write the docs", status: "backlog" }], mac: null }, { updatedAt: 9_000 });
  const board = renderHook(() => useTaskBoard());
  await vi.waitFor(() => expect(board.result.current.sections.map((section) => section.key)).toEqual(["mac-copy", "brain:brain-1"]));
  expect(board.result.current.sections[0]).toMatchObject({ namesOn: null, copy: { at: 9_000, cloudOnly: false } });
  expect(board.result.current.available).toBe(true);
});

// @vitest-environment jsdom
import type { ProjectGit, RpcMethod } from "@openorc/protocol";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { useChangesCount } from "./use-changes-count";

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, git: "ready" as ProjectGit, files: 3, asked: [] as RpcMethod[] }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method) => {
    mac.asked.push(method);
    if (method === "projects.git") return Promise.resolve(mac.git);
    if (method === "review.threadChanges") return Promise.resolve({ comparison: "head", baseSha: null, totals: { files: mac.files, insertions: 2, deletions: 1 }, files: [], unlisted: 0 });
    return Promise.resolve(null);
  });
  return mac.phone.module;
});

beforeEach(() => {
  mac.git = "ready";
  mac.files = 3;
  mac.asked.length = 0;
  mac.phone!.module.queryClient.clear();
});
afterEach(cleanup);

const settings = fixtureThreads.find((thread) => thread.id === "t-settings")!;
const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;

it("counts the uncommitted files of a thread with Git", async () => {
  const { result } = renderHook(() => useChangesCount(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(result.current).toBe(3));
});

it("keeps Changes with a clean workspace, at zero", async () => {
  mac.files = 0;
  const { result } = renderHook(() => useChangesCount(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.asked).toContain("review.threadChanges"));
  await waitFor(() => expect(result.current).toBe(0));
});

it("has no Changes in a Workspace thread, and asks the Mac nothing", async () => {
  const { result } = renderHook(() => useChangesCount(plan), { wrapper: mac.phone!.wrapper });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result.current).toBeNull();
  expect(mac.asked).toEqual([]);
});

it("has no Changes in a folder without Git", async () => {
  mac.git = "none";
  const { result } = renderHook(() => useChangesCount(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.asked).toContain("projects.git"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result.current).toBeNull();
  expect(mac.asked).not.toContain("review.threadChanges");
});

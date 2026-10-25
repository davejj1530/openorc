// @vitest-environment jsdom
import type { FileDiff, RpcMethod, WorkspaceChanges } from "@openorc/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { DiffScreen } from "./DiffScreen";

type Step = { icon: string; accessibilityLabel: string; disabled?: boolean; onPress: () => void };

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, path: "b.ts", steps: [] as Step[], reads: {} as Partial<Record<RpcMethod, (params: unknown) => Promise<unknown>>> }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => mac.reads[method]?.(params) ?? Promise.reject(new Error(`no ${method}`)));
  return { ...mac.phone.module, useLinkState: () => ({ kind: "connected", mac: { id: "mac-1", name: "Studio" }, route: { kind: "lan", host: "s", port: 1 }, serial: 1 }) };
});
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  const Toolbar = ({ children }: { children?: ReactNode }) => {
    mac.steps = [];
    return <>{children}</>;
  };
  Toolbar.Button = (props: Step) => {
    mac.steps.push(props);
    return null;
  };
  Stack.Toolbar = Toolbar;
  const navigation = { setOptions: () => undefined, isFocused: () => true, addListener: () => () => undefined };
  return { router: { setParams: vi.fn() }, Stack, useLocalSearchParams: () => ({ threadId: "t1", path: mac.path, comparison: "head" }), useNavigation: () => navigation };
});

const list: WorkspaceChanges = {
  comparison: "head",
  baseSha: null,
  totals: { files: 3, insertions: 3, deletions: 0 },
  files: ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, oldPath: null, status: "modified", body: { kind: "text", insertions: 1, deletions: 0 } })),
  unlisted: 0,
};
const diff = (over: Partial<FileDiff>): FileDiff => ({
  path: mac.path,
  oldPath: null,
  status: "modified",
  body: { kind: "text", insertions: 1, deletions: 0 },
  patch: "@@ -1 +1,2 @@\n keep\n+added\n",
  cut: null,
  ...over,
});

beforeEach(() => {
  mac.phone!.module.queryClient.clear();
  vi.mocked(router.setParams).mockClear();
  mac.reads = { "review.threadChanges": async () => list, "review.threadFileDiff": async () => diff({}) };
});
afterEach(cleanup);

const step = (label: string) => mac.steps.find((item) => item.accessibilityLabel === label)!;

it("steps to the previous and next file in the list's order, dimmed at either end", async () => {
  mac.path = "b.ts";
  render(<DiffScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(screen.getByText("Copy")).toBeTruthy());
  expect([step("Previous file").icon, step("Next file").icon]).toEqual(["chevron.up", "chevron.down"]);
  step("Next file").onPress();
  expect(router.setParams).toHaveBeenCalledWith({ path: "c.ts" });
  step("Previous file").onPress();
  expect(router.setParams).toHaveBeenCalledWith({ path: "a.ts" });
  cleanup();
  mac.path = "c.ts";
  render(<DiffScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(step("Next file").disabled).toBe(true));
  expect(step("Previous file").disabled).toBe(false);
});

it("says why a file draws no lines, and where a cut diff stops", async () => {
  mac.path = "a.ts";
  mac.reads["review.threadFileDiff"] = async () => diff({ body: { kind: "omitted", reason: "large", bytes: 2_500_000 }, patch: "" });
  render(<DiffScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(screen.getByText("Too large to show (2.4 MB)")).toBeTruthy());
  cleanup();
  mac.phone!.module.queryClient.clear();
  mac.reads["review.threadFileDiff"] = async () => diff({ cut: { shownLines: 5000, totalLines: 23410 } });
  render(<DiffScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(screen.getByText("5,000 of 23,410 lines")).toBeTruthy());
});

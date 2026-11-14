import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLoaded } from "./use-loaded";

afterEach(cleanup);

function later<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}

it("reads nothing for no key, and lets only the latest read land", async () => {
  const reads: ReturnType<typeof later<string>>[] = [];
  const hook = renderHook(({ key }: { key: string | null }) => useLoaded(key, () => (reads.push(later<string>()), reads.at(-1)!.promise)), { initialProps: { key: null as string | null } });
  expect(hook.result.current).toMatchObject({ data: undefined, error: null, loading: false });
  expect(reads).toHaveLength(0);
  hook.rerender({ key: "a" });
  expect(hook.result.current.loading).toBe(true);
  hook.rerender({ key: "b" });
  await act(async () => reads[1]!.resolve("for b"));
  await act(async () => reads[0]!.resolve("for a"));
  expect(hook.result.current).toMatchObject({ data: "for b", loading: false });
});

it("keeps what it read beside a later failure", async () => {
  const reads: ReturnType<typeof later<string>>[] = [];
  const hook = renderHook(() => useLoaded("a", () => (reads.push(later<string>()), reads.at(-1)!.promise)));
  await act(async () => reads[0]!.resolve("first"));
  act(() => hook.result.current.refetch());
  await act(async () => reads[1]!.reject(new Error("OpenOrc Cloud can't be reached.")));
  expect(hook.result.current).toMatchObject({ data: "first", error: new Error("OpenOrc Cloud can't be reached."), loading: false });
});

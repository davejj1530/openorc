import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { refreshHome } from "./refresh";

const mac = { id: "studio", name: "Studio" };
const connected: LinkState = { kind: "connected", mac, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };

/** A query Home shows, read once already, counting each time it is read. */
function shown(client: QueryClient, key: unknown[]) {
  const read = vi.fn(() => Promise.resolve([]));
  const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
  const stop = observer.subscribe(() => undefined);
  return { read, stop, loaded: () => observer.getCurrentResult().isSuccess };
}

it("reads Home's lists again when connected, and settles once they are back", async () => {
  const client = new QueryClient();
  const lists = [shown(client, ["projects.list", {}]), shown(client, ["threads.list", { projectId: "p" }]), shown(client, ["inbox.list", {}])];
  const other = shown(client, ["agents.models", {}]);
  await vi.waitFor(() => expect([...lists, other].every((list) => list.loaded())).toBe(true));
  const retry = vi.fn(() => Promise.resolve());
  await refreshHome({ getState: () => connected, retry }, client);
  expect(lists.map((list) => list.read.mock.calls.length)).toEqual([2, 2, 2]);
  expect(other.read).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
  [...lists, other].forEach((list) => list.stop());
});

it("connects now instead of reading, when the phone is not connected, and settles with that attempt", async () => {
  const client = new QueryClient();
  let settle = () => undefined as void;
  const retry = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
  let done = false;
  const refreshing = refreshHome({ getState: () => ({ kind: "waiting", mac, why: "unreachable", retryAt: 9 }), retry }, client).then(() => (done = true));
  expect(retry).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(done).toBe(false);
  settle();
  await refreshing;
  expect(done).toBe(true);
});

// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcMethod } from "@openorc/protocol";
import { testClient } from "./test-fixtures/fake-connection.js";

const ID = "thread-1";
type Place = "mac" | "cloud";

/**
 * A thread's view as the window draws it: its summary, a read it makes wherever the thread is, and one read of each
 * place's own that only the view for that place makes. A core that answers each read from where the thread is now, and
 * refuses a read of the other place, as this Mac and OpenOrc Cloud refuse each other's.
 */
function threadView(start: Place) {
  const harness = testClient();
  const { client, call, wrapper, push } = harness;
  let place: Place = start;
  const asked: { method: RpcMethod; place: Place; refused: boolean }[] = [];
  const onlyAt: Partial<Record<RpcMethod, Place>> = { "hosted.capabilities": "cloud", "git.threadPushState": "mac" };
  call.mockImplementation(async (method) => {
    const refused = onlyAt[method] !== undefined && onlyAt[method] !== place;
    asked.push({ method, place, refused });
    if (refused) throw new Error(`${method} isn't read at ${place}.`);
    if (method === "threads.get") return { id: ID, owner: place === "cloud" ? { brain: "hosted" } : undefined };
    return { place };
  });
  const Cloud = () => (client.useRpc("hosted.capabilities", { threadId: ID }), null);
  const Mac = () => (client.useRpc("git.threadPushState", { threadId: ID }), null);
  const Thread = () => {
    const summary = client.useRpc("threads.get", { id: ID }).data as { owner?: { brain: string } } | undefined;
    client.useRpc("threads.messages", { id: ID });
    if (!summary) return null;
    return createElement(Fragment, null, createElement(summary.owner?.brain === "hosted" ? Cloud : Mac));
  };
  render(createElement(Thread), { wrapper });
  /** The thread is read at `to` from now on, and the core says so as CloudMoves does. */
  const move = async (to: Place) => {
    place = to;
    await act(async () => {
      push({ type: "invalidate", keys: ["threads", `thread:${ID}`, `place:${ID}`] });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  };
  return { asked, move, client };
}

afterEach(cleanup);

describe("a thread read at another place from now on", () => {
  it("never asks the place it left again, and reads again where it is what the view still shows, moving to the cloud", async () => {
    const view = threadView("mac");
    await waitFor(() => expect(view.asked.map((each) => each.method)).toContain("git.threadPushState"));
    const before = view.asked.length;
    await view.move("cloud");
    const after = view.asked.slice(before);
    expect(after.filter((each) => each.refused)).toEqual([]);
    expect(after.map((each) => each.method)).toEqual(expect.arrayContaining(["threads.get", "threads.messages", "hosted.capabilities"]));
    expect(after.find((each) => each.method === "threads.messages")?.place, "the read both places make, asked where it is now").toBe("cloud");
    // What the old place's view read is let go of, not kept for a view that may mount later.
    expect(view.client.queryClient.getQueryData(["git.threadPushState", { threadId: ID }])).toBeUndefined();
  });

  it("does the same moving to this Mac", async () => {
    const view = threadView("cloud");
    await waitFor(() => expect(view.asked.map((each) => each.method)).toContain("hosted.capabilities"));
    const before = view.asked.length;
    await view.move("mac");
    const after = view.asked.slice(before);
    expect(after.filter((each) => each.refused)).toEqual([]);
    expect(after.map((each) => each.method)).toEqual(expect.arrayContaining(["threads.get", "threads.messages", "git.threadPushState"]));
    expect(view.client.queryClient.getQueryData(["hosted.capabilities", { threadId: ID }])).toBeUndefined();
  });

  it("refetches as before when no thread changed place", async () => {
    const view = threadView("mac");
    await waitFor(() => expect(view.asked.map((each) => each.method)).toContain("git.threadPushState"));
    const before = view.asked.length;
    await act(async () => {
      view.client.invalidateTags([`thread:${ID}`], { immediate: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(view.asked.slice(before).map((each) => each.method)).toContain("threads.get");
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ThreadSummary } from "@openorc/protocol";
import { afterEach, expect, it } from "vitest";
import { ThreadMoveCard } from "./ThreadMoveCard";

afterEach(cleanup);

const thread = (extra: Partial<ThreadSummary>) => ({ id: "thread", moving: null, ...extra }) as ThreadSummary;
const steps = () =>
  within(screen.getByRole("status"))
    .getAllByRole("listitem")
    .map((item) => `${item.textContent}: ${item.dataset["state"]}`);

it("shows a conversation's move to the cloud as steps, the current one running", () => {
  render(<ThreadMoveCard thread={thread({ moving: { to: "cloud", since: 1, step: "sending" } })} />);
  expect(screen.getByRole("status", { name: "Moving to the cloud" })).toBeTruthy();
  expect(steps()).toEqual(["Packing the conversation: done", "Waking the cloud brain: done", "Sending it to the cloud: running"]);
});

it("says the cloud brain is waking on an open cloud conversation, and shows nothing once it is live", () => {
  const { rerender } = render(<ThreadMoveCard thread={thread({ owner: { brain: "cloud", reach: "waking", heardAt: 1 } })} />);
  expect(steps()).toEqual(["Waking the cloud brain: running"]);
  rerender(<ThreadMoveCard thread={thread({ owner: { brain: "cloud", reach: "live", heardAt: 1 } })} />);
  expect(screen.queryByRole("status")).toBeNull();
});

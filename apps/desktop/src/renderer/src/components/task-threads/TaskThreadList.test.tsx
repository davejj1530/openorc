import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskThreadLink, ThreadSummary } from "@openorc/protocol";
import * as router from "../../lib/router";
import { TaskThreadList } from "./TaskThreadList";

const openThread = vi.spyOn(router, "openThread").mockImplementation(() => {});
afterEach(cleanup);

it("lists the task's threads by what they are to it, a button's by its label even when that is Work", () => {
  const thread = (id: string, activity: ThreadSummary["activity"]) => ({ id, title: `Thread ${id}`, activity, lastActivityAt: Date.now(), updatedAt: Date.now() }) as ThreadSummary;
  const links: TaskThreadLink[] = [
    { thread: thread("a", "idle"), label: null, current: true },
    { thread: thread("b", "running"), label: "Review", current: false },
    { thread: thread("c", "idle"), label: null, current: false },
    { thread: thread("d", "idle"), label: "Work", current: false },
  ];
  render(<TaskThreadList links={links} />);
  expect(screen.getByRole("button", { name: /Thread a Current thread/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Thread b Review · Working/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Thread d Work · / })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Thread c Earlier thread/ }));
  expect(openThread).toHaveBeenCalledWith("c");
});

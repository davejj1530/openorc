import type { ProjectActivity as Activity, RpcParams } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectActivity } from "./ProjectActivity";

const reads = vi.hoisted(() => ({ data: undefined as Activity | undefined, params: [] as RpcParams<"projects.activity">[] }));
vi.mock("../lib/client", () => ({
  ensureRpc: vi.fn(),
  useRpc: (_method: string, params: RpcParams<"projects.activity">) => {
    reads.params.push(params);
    return { data: reads.data && { days: reads.data.days.slice(0, params.boundaries.length - 1) } };
  },
}));
afterEach(() => {
  cleanup();
  reads.data = undefined;
  reads.params = [];
});

const quiet = { turns: 0, steps: 0, threads: 0, agents: [] };
function year(busy: Record<number, Activity["days"][number]>): Activity {
  return { days: Array.from({ length: 400 }, (_, index) => busy[index] ?? quiet) };
}

it("shows the year's turns, and a hovered day's threads and agents, for the project it was given", () => {
  reads.data = year({
    3: {
      turns: 5,
      steps: 40,
      threads: 2,
      agents: [
        { agent: "claude", turns: 4 },
        { agent: "codex", turns: 1 },
      ],
    },
    4: { turns: 2, steps: 9, threads: 1, agents: [{ agent: "codex", turns: 2 }] },
  });
  render(<ProjectActivity projectId="p1" />);
  expect(reads.params.at(-1)?.id).toBe("p1");
  const days = screen.getByRole("img", { name: "7 turns and 49 steps in the last year" });
  const readout = (hidden: boolean) => document.querySelector(`.new-thread-activity-readout [aria-hidden="${hidden}"]`)?.textContent;
  expect(readout(false)).toBe("7 turns and 49 steps in the last year");

  fireEvent.pointerOver(days.querySelector('[data-day="3"]')!);
  expect(readout(false)).toContain("5 turns and 40 steps in 2 threads");
  expect(readout(false)).toMatch(/41$/);
  expect(document.querySelector('[data-day="3"]')!.getAttribute("data-level")).toBe("4");
  expect(document.querySelector('[data-day="4"]')!.getAttribute("data-level")).toBe("1");

  fireEvent.pointerLeave(days);
  expect(readout(false)).toBe("7 turns and 49 steps in the last year");
});

it("dates the count from the first active day when the activity starts inside the year", () => {
  reads.data = year({ 300: { turns: 3, steps: 7, threads: 1, agents: [] } });
  render(<ProjectActivity projectId="p1" />);
  const start = reads.params.at(-1)!.boundaries[300]!;
  const label = new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  expect(screen.getByRole("img", { name: `3 turns and 7 steps since ${label}` })).toBeTruthy();
});

it("stays empty for a project with no turns in the year", () => {
  reads.data = year({});
  render(<ProjectActivity projectId="p1" />);
  expect(screen.queryByRole("img")).toBeNull();
});

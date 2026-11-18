// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NewThreadMark } from "./NewThreadMark";

const thread = (activity: "idle" | "running") => ({ activity, session: { status: "ready" }, unread: false });
const listed = vi.hoisted(() => ({ threads: [] as ReturnType<typeof thread>[] }));
vi.mock("../lib/space-queries", () => ({ useSpaceRpc: () => ({ data: listed.threads }) }));

afterEach(() => {
  listed.threads = [];
});

const mark = () => render(<NewThreadMark />).container.querySelector("svg")!;

it("rests while no agent works", () => {
  listed.threads = [thread("idle")];
  expect(mark().classList.contains("working-cube")).toBe(false);
});

it("is the working cube while any agent works", () => {
  listed.threads = [thread("idle"), thread("running")];
  const svg = mark();
  expect(svg.classList.contains("working-cube")).toBe(true);
  expect(svg.querySelectorAll(".openorc-mark-face")).toHaveLength(3);
});

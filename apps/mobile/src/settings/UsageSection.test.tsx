// @vitest-environment jsdom
import type { PlanLimits } from "@openorc/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { nativeProps } from "../test-fixtures/react-native";
import { UsageSection } from "./UsageSection";

const now = Date.UTC(2026, 10, 19, 14, 21);
const observedAt = now - 7 * 60_000;
const limits = (id: string, name: string): PlanLimits => ({
  id,
  provider: "claude",
  name,
  plan: "Max",
  status: "available",
  windows: [{ id: `${id}:five_hour`, label: "5-hour window", usedPercent: 24, remainingPercent: 76, resetsAt: now + 3 * 3_600_000, observedAt, exhausted: false }],
  refreshedAt: observedAt,
});

vi.mock("./use-usage", () => ({
  useUsage: () => ({ accounts: [limits("claude:work", "Claude")], state: "ready", live: true, readAt: observedAt, hostName: "Studio", retry: () => undefined, now }),
  useCloudLimits: () => [limits("cloud:claude:personal", "OpenOrc Cloud · Personal")],
}));

afterEach(cleanup);

it("says when a cloud reading was taken, never out of date by its age, while a Mac reading of the same age warns", () => {
  render(<UsageSection />);
  const reported = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(observedAt);
  const labels = screen.getAllByLabelText(/^5-hour window, 76% left, /).map((each) => each.getAttribute("aria-label"));
  expect(labels).toEqual([`5-hour window, 76% left, Out of date · reported ${reported}`, `5-hour window, 76% left, Reported ${reported}`]);
  const shares = screen.getAllByText("76% left");
  expect(shares.map((share) => String(nativeProps.get(share)?.className).includes("text-warn"))).toEqual([true, false]);
});

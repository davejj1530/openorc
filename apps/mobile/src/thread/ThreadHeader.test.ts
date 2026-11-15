import type { ThreadSummary } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import { statusLine } from "./ThreadHeader";

vi.mock("../client", () => ({}));
vi.mock("expo-router", () => ({ router: {} }));

const base = { ...fixtureThreads[0]!, id: "t1", projectId: "p1", title: "Add a footer", agent: "claude" } satisfies ThreadSummary;

it("names the starter when a shared thread waits on an answer", () => {
  const thread: ThreadSummary = { ...base, activity: "waiting", owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Morgan Reed", image: null } } };
  expect(statusLine(thread, "Project")).toContain("Waiting on Morgan");
  expect(statusLine(thread, "Project")).not.toContain("Needs you");
  expect(statusLine({ ...thread, owner: undefined }, "Project")).toContain("Needs you");
});

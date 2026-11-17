import type { ThreadSummary } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import { statusLine, statusParts, threadLinkLine } from "./ThreadHeader";

vi.mock("../client", () => ({}));
vi.mock("expo-router", () => ({ router: {} }));

const base = { ...fixtureThreads[0]!, id: "t1", projectId: "p1", title: "Add a footer", agent: "claude" } satisfies ThreadSummary;

it("names the starter when a shared thread waits on an answer", () => {
  const thread: ThreadSummary = { ...base, activity: "waiting", owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Morgan Reed", image: null } } };
  expect(statusLine(thread, "Project")).toContain("Waiting on Morgan");
  expect(statusLine(thread, "Project")).not.toContain("Needs you");
  expect(statusLine({ ...thread, owner: undefined }, "Project")).toContain("Needs you");
});

it("says a cloud thread is on OpenOrc Cloud after its project while it says no state, the Mac's own name for it or the server's", () => {
  const cloud: ThreadSummary = { ...base, activity: "idle", owner: { brain: "hosted", reach: "live", heardAt: 1 } };
  expect(statusLine(cloud, "canvas")).toBe("canvas · OpenOrc Cloud");
  expect(statusLine({ ...cloud, owner: { ...cloud.owner!, project: { name: "billing-service" } } }, undefined)).toBe("billing-service · OpenOrc Cloud");
  expect(statusLine({ ...cloud, owner: undefined }, "canvas")).toBe("canvas");
});

it("keeps a cloud thread's state whole by leaving OpenOrc Cloud out while it says one", () => {
  const mara = { id: "u-mara", name: "Mara Okafor", image: null };
  const waiting: ThreadSummary = {
    ...base,
    activity: "waiting",
    owner: {
      brain: "hosted",
      reach: "live",
      heardAt: 1,
      startedBy: { name: "Mara Okafor", image: null },
      collaboration: {
        viewer: { id: "u-riley", name: "Riley Chen", image: null },
        canWrite: true,
        live: null,
        send: "now",
        handoff: null,
        canPostNote: true,
        canStop: true,
        ask: { id: "ask", turnId: "turn", state: "parked", sender: mara, answer: "start", canDecline: true, reason: null },
        queue: [],
        mentions: { unread: false, firstUnreadNoteId: null },
        noteHead: 0,
      },
    },
  };
  expect(statusParts(waiting, "canvas")).toEqual({ where: "canvas", state: "Waiting for an answer" });
  expect(statusLine(waiting, "canvas")).toBe("canvas · Waiting for an answer");
});

it("says the Mac's link trouble under a Mac thread's title, and nothing of it under a cloud thread the phone reaches itself", () => {
  const trouble = { tone: "trouble", status: "Not reachable" };
  const cloud = { owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 1 } };
  expect(threadLinkLine(trouble, { owner: undefined }, true)).toBe("Not reachable");
  expect(threadLinkLine(trouble, cloud, false)).toBe("Not reachable");
  expect(threadLinkLine(trouble, cloud, true)).toBeNull();
  expect(threadLinkLine({ tone: "ok", status: "Connected" }, { owner: undefined }, false)).toBeNull();
});

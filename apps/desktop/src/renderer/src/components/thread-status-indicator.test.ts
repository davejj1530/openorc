import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt" | "backgroundCommands" | "owner">;
const idle: StatusFields = {
  activity: "idle",
  session: { status: "idle", message: null },
  unread: false,
  doneAt: null,
};
const render = (changes: Partial<StatusFields> = {}) => renderToStaticMarkup(createElement(ThreadStatusIndicator, { thread: { ...idle, ...changes } }));

describe("sidebar thread status", () => {
  it("keeps the question mark in quiet ink when it waits on a teammate", () => {
    const html = render({ activity: "waiting", owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Morgan Reed", image: null } } });
    expect(html).toContain('aria-label="Waiting on Morgan"');
    expect(html).toContain('data-mark="ask"');
    expect(html).toContain("text-ink-3");
    expect(html).not.toContain("text-attention");
  });

  it.each([
    ["waiting", "Needs you", 'data-mark="ask"'],
    ["running", "Working", 'class="working-cube"'],
  ] as const)("shows %s ahead of failure, unread and completion", (activity, label, mark) => {
    const html = render({ activity, session: { status: "error", message: "Previous failure" }, unread: true, doneAt: 1 });
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`data-tip="${label}"`);
    expect(html).toContain(mark);
    expect(html.match(/role="img"/g)).toHaveLength(1);
    expect(html).not.toContain("Previous failure");
  });

  it.each([["lost", "Session lost"]] as const)("shows %s ahead of unread and completion, including the failure reason", (status, label) => {
    const html = render({ session: { status, message: "Provider unavailable" }, unread: true, doneAt: 1 });
    expect(html).toContain(`aria-label="${label}: Provider unavailable"`);
    expect(html).toContain(`data-tip="${label}: Provider unavailable"`);
    expect(html).toContain('data-mark="failed"');
  });

  it.each([["error", "Failed"]] as const)("provides a fallback for %s without a message", (status, label) => {
    expect(render({ session: { status, message: null } })).toContain(`aria-label="${label}"`);
  });

  it("shows unread ahead of completion", () => {
    const html = render({ unread: true, doneAt: 1 });
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain('data-tip="Unread"');
    expect(html).toContain('data-mark="unread"');
    expect(html).not.toContain('data-icon="Check"');
  });

  it("marks a resting thread whose agent left commands running, such as a dev server", () => {
    const html = render({
      backgroundCommands: [
        { id: "b1", description: "pnpm dev" },
        { id: "b2", description: "Metro" },
      ],
    });
    expect(html).toContain('aria-label="2 background commands are running"');
    expect(html).toContain('data-tip="2 background commands are running"');
    expect(html).toContain('data-mark="background"');
    expect(render({ backgroundCommands: [{ id: "b1", description: "pnpm dev" }], unread: true })).toContain('aria-label="Unread"');
  });

  it.each(["live"] as const)("leaves a read, idle thread without an indicator when its session is %s", (status) => {
    expect(render({ session: { status, message: null } })).toBe("");
  });
});

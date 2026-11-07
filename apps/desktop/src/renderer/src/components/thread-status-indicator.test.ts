import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";

type StatusFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt" | "backgroundCommands">;
const idle: StatusFields = {
  activity: "idle",
  session: { status: "idle", message: null },
  unread: false,
  doneAt: null,
};
const render = (changes: Partial<StatusFields> = {}) => renderToStaticMarkup(createElement(ThreadStatusIndicator, { thread: { ...idle, ...changes } }));

describe("sidebar thread status", () => {
  it.each([
    ["waiting", "Needs you", "CircleHelp"],
    ["running", "Working", "LoaderCircle"],
  ] as const)("shows %s ahead of failure, unread and completion", (activity, label, icon) => {
    const html = render({ activity, session: { status: "error", message: "Previous failure" }, unread: true, doneAt: 1 });
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain(`data-icon="${icon}"`);
    expect(html.match(/role="img"/g)).toHaveLength(1);
    expect(html).not.toContain("Previous failure");
  });

  it.each([["lost", "Session lost"]] as const)("shows %s ahead of unread and completion, including the failure reason", (status, label) => {
    const html = render({ session: { status, message: "Provider unavailable" }, unread: true, doneAt: 1 });
    expect(html).toContain(`aria-label="${label}: Provider unavailable"`);
    expect(html).toContain(`title="${label}: Provider unavailable"`);
    expect(html).toContain('data-icon="AlertCircle"');
  });

  it.each([["error", "Failed"]] as const)("provides a fallback for %s without a message", (status, label) => {
    expect(render({ session: { status, message: null } })).toContain(`aria-label="${label}"`);
  });

  it("shows unread ahead of completion", () => {
    const html = render({ unread: true, doneAt: 1 });
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain('title="Unread"');
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
    expect(html).toContain('title="2 background commands are running"');
    expect(html).toContain('data-icon="Terminal"');
    expect(render({ backgroundCommands: [{ id: "b1", description: "pnpm dev" }], unread: true })).toContain('aria-label="Unread"');
  });

  it.each(["live"] as const)("leaves a read, idle thread without an indicator when its session is %s", (status) => {
    expect(render({ session: { status, message: null } })).toBe("");
  });
});

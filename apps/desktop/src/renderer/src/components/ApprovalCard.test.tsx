import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[]);
vi.mock("../lib/rpc", () => ({ core: { call: (method: string, params: unknown) => void calls.push({ method, params }) } }));

const { ApprovalCard } = await import("./ApprovalCard");

afterEach(() => {
  cleanup();
  calls.length = 0;
});

it("shows a command to read before it runs, and answers with the choice pressed", () => {
  const command = "rm -rf build && npm run build";
  for (const name of ["Deny", "Allow for this run", "Allow once"]) {
    render(<ApprovalCard runId="r1" block={{ id: "a", kind: "approval", approvalId: "a", approvalKind: "tool", toolName: "Bash", input: { command } }} />);
    expect(screen.getByText("Run this command?")).toBeTruthy();
    expect(screen.getByText(command)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name }));
    // The card takes one answer at a time.
    expect(screen.getByRole("button", { name: "Allow once" }).hasAttribute("disabled")).toBe(true);
    cleanup();
  }
  expect(calls.map((call) => (call as { params: { decision: string } }).params.decision)).toEqual(["deny", "allow_for_run", "allow"]);
});

it("denies with a note written in its own line, and only from there", () => {
  render(<ApprovalCard runId="r1" block={{ id: "a", kind: "approval", approvalId: "a", approvalKind: "command", toolName: "Bash", input: { command: "pnpm build" } }} />);
  expect(screen.queryByRole("button", { name: "Deny and send" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "What to do instead of Bash" }), { target: { value: "Build only the pricing page" } });
  fireEvent.click(screen.getByRole("button", { name: "Deny and send" }));
  expect(calls).toEqual([{ method: "approvals.resolve", params: { runId: "r1", approvalId: "a", decision: "deny", note: "Build only the pricing page" } }]);
});

it("asks in the agent's reason, shows the request as summed up with the raw request on demand, and offers only Allow once when that is all that applies", () => {
  render(
    <ApprovalCard
      runId="r1"
      block={{
        id: "b",
        kind: "approval",
        approvalId: "b",
        approvalKind: "app_action",
        toolName: "orcling_thread_start",
        reason: "Autumn wants to start work in openorc",
        onceOnly: true,
        input: { prompt: "Fix it" },
      }}
    />,
  );
  expect(screen.getByText("Autumn wants to start work in openorc")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show request" }));
  expect(screen.getByText(/"prompt": "Fix it"/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide request" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow for this run" })).toBeNull();
});

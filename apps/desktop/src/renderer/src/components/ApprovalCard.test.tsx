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
  render(<ApprovalCard runId="r1" block={{ id: "a", kind: "approval", approvalId: "a", approvalKind: "tool", toolName: "Bash", input: { command } }} />);
  expect(screen.getByText("Run this command?")).toBeTruthy();
  expect(screen.getByText(command)).toBeTruthy();
  for (const name of ["Deny", "Allow for this run", "Allow"]) fireEvent.click(screen.getByRole("button", { name }));
  expect(calls.map((call) => (call as { params: { decision: string } }).params.decision)).toEqual(["deny", "allow_for_run", "allow"]);
});

it("lets a reason say what a request does, with its fields on demand, and offers only Allow once when that is all that applies", () => {
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
  expect(screen.queryByText(/"prompt"/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show request" }));
  expect(screen.getByText(/"prompt": "Fix it"/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow for this run" })).toBeNull();
});

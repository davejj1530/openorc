// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageQueue } from "./MessageQueue";

afterEach(cleanup);

it("says a queued message that failed did not send, in its first line, with Retry and Remove in reach", () => {
  const error = "Docker did not start in the sandbox.\n" + "time=1 level=info msg=line\n".repeat(40);
  const failed = { id: "m1", text: "Add a footer with the links", attachments: [], queuedAt: 1, interrupted: true, error };
  const onSend = vi.fn();
  render(<MessageQueue messages={[failed]} canSend pending={false} agentName="Claude" typing={false} onSend={onSend} onRemove={() => undefined} />);
  expect(screen.getByText("Didn't send")).toBeTruthy();
  expect(screen.queryByText(/Sends when/)).toBeNull();
  expect(screen.getByText("Docker did not start in the sandbox.")).toBeTruthy();
  expect(screen.queryByText(/level=info/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onSend).toHaveBeenCalledWith("m1");
});

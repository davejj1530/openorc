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

it("starts the reader's own paused message as their turn, says why it waits, and leaves another message to Send now", () => {
  const paused = { id: "mine", text: "This was for the turn that ended.", attachments: [], queuedAt: 1 };
  const waiting = { id: "other", text: "Then the header.", attachments: [], queuedAt: 2 };
  const onStart = vi.fn();
  const onSend = vi.fn();
  const { rerender } = render(
    <MessageQueue
      messages={[paused, waiting]}
      canSend={false}
      pending={false}
      agentName="Claude"
      typing={false}
      onSend={onSend}
      onRemove={() => undefined}
      paused={new Map([["mine", { canStart: true, hint: "The turn this was sent to has ended." }]])}
      onStart={onStart}
    />,
  );
  expect(screen.getByText("The turn this was sent to has ended.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start turn" }));
  expect(onStart).toHaveBeenCalledWith("mine");
  expect(screen.getByRole("button", { name: "Send now" }).getAttribute("aria-disabled") ?? "").not.toBe("false");
  rerender(
    <MessageQueue
      messages={[paused]}
      canSend={false}
      pending={false}
      agentName="Claude"
      typing={false}
      onSend={onSend}
      onRemove={() => undefined}
      paused={new Map([["mine", { canStart: false, hint: null }]])}
      onStart={onStart}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start turn" }));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});

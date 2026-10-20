import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageQueue } from "./MessageQueue";

afterEach(cleanup);

it("sends and removes the selected message by id as earlier rows disappear", () => {
  const onSend = vi.fn(),
    onRemove = vi.fn();
  const first = { id: "first", text: "First", attachments: [], queuedAt: 1 };
  const second = { id: "second", text: "Second", attachments: [], queuedAt: 2 };
  const props = { canSend: true, pending: false, onSend, onRemove };
  const mounted = render(<MessageQueue {...props} messages={[first, second]} />);
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /2 queued/ }));
  fireEvent.click(screen.getAllByRole("button", { name: "Send now" })[1]!);
  expect(onSend).toHaveBeenLastCalledWith("second");
  mounted.rerender(<MessageQueue {...props} messages={[second]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
  expect(onRemove).toHaveBeenLastCalledWith("second");
});

it("opens the pile on its own when a message failed to send", () => {
  const failed = { id: "failed", text: "Failed", attachments: [], queuedAt: 1, error: "Could not deliver" };
  render(<MessageQueue canSend pending={false} onSend={vi.fn()} onRemove={vi.fn()} messages={[failed]} />);
  expect(screen.getByRole("status").textContent).toBe("Could not deliver");
  expect(screen.getByRole("button", { name: /1 queued/ }).getAttribute("aria-expanded")).toBe("true");
});

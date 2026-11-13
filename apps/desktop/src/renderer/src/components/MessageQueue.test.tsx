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

it("offers to try a refused message again, disabled with the words while it still cannot start a turn", () => {
  const onSend = vi.fn();
  const refused = { id: "refused", text: "Then open a pull request", attachments: [], queuedAt: 1, error: "You're out of cloud hours." };
  const mounted = render(<MessageQueue canSend={false} pending={false} retryBlocked="You're out of cloud hours." onSend={onSend} onRemove={vi.fn()} messages={[refused]} />);
  const again = screen.getByRole("button", { name: "Try again" });
  expect(again.hasAttribute("disabled")).toBe(true);
  expect(again.getAttribute("data-tip")).toBe("You're out of cloud hours.");
  mounted.rerender(<MessageQueue canSend={false} pending={false} retryBlocked={null} onSend={onSend} onRemove={vi.fn()} messages={[refused]} />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(onSend).toHaveBeenCalledWith("refused");
});

it("takes a message back to the composer when its words are pressed, and keeps Send now and the cross beside them", () => {
  const onEdit = vi.fn();
  const queued = { id: "queued", text: "Then open a pull request", attachments: [], queuedAt: 1 };
  render(<MessageQueue canSend pending={false} onSend={vi.fn()} onRemove={vi.fn()} onEdit={onEdit} messages={[queued]} />);
  fireEvent.click(screen.getByRole("button", { name: /1 queued/ }));
  expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove queued message 1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Then open a pull request" }));
  expect(onEdit).toHaveBeenCalledWith("queued");
});

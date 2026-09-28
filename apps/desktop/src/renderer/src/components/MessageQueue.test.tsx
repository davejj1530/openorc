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
  fireEvent.click(screen.getAllByRole("button", { name: "Send now" })[1]!);
  expect(onSend).toHaveBeenLastCalledWith("second");
  mounted.rerender(<MessageQueue {...props} messages={[second]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove queued message 1" }));
  expect(onRemove).toHaveBeenLastCalledWith("second");
});

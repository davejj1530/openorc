// @vitest-environment jsdom
import type { TeamMessage } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Reactions } from "./Reactions";

afterEach(cleanup);

const message = (reactions: TeamMessage["reactions"]) => ({ id: "m1", reactions }) as unknown as TeamMessage;

it("counts a reaction past one, marks the reader's own, and a tap takes it back or adds it", () => {
  const onReact = vi.fn();
  render(
    <Reactions
      message={message([
        { emoji: "👍", userIds: ["u-riley", "u-mara"] },
        { emoji: "🎉", userIds: ["u-mara"] },
      ])}
      self="u-riley"
      mine={false}
      onReact={onReact}
    />,
  );
  const thumbs = screen.getByRole("button", { name: "👍, 2 reactions" });
  const party = screen.getByRole("button", { name: "🎉, 1 reactions" });
  expect(thumbs.textContent).toBe("👍2");
  expect(party.textContent).toBe("🎉");
  expect(thumbs.getAttribute("aria-selected")).toBe("true");
  expect(party.getAttribute("aria-selected")).toBe("false");
  fireEvent.click(thumbs);
  fireEvent.click(party);
  expect(onReact.mock.calls).toEqual([["👍"], ["🎉"]]);
});

it("draws nothing for a message without reactions, and holds one the phone does not know", () => {
  const onReact = vi.fn();
  const { container } = render(<Reactions message={message([])} self="u-riley" mine onReact={onReact} />);
  expect(container.textContent).toBe("");
  cleanup();
  render(<Reactions message={message([{ emoji: "🦄", userIds: ["u-mara"] }])} self="u-riley" mine onReact={onReact} />);
  fireEvent.click(screen.getByRole("button", { name: "🦄, 1 reactions" }));
  expect(onReact).not.toHaveBeenCalled();
});

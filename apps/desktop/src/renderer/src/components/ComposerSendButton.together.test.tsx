import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerSendCluster } from "./ComposerSendButton";

afterEach(cleanup);

const payer = { now: "Joins Mara's turn, on their sign-in and hours.", queue: "After Mara's turn, using your sign-in and hours.", send: null, stop: "Stop Mara's turn" };

it("says on demand whose sign-in and hours Send now, Queue and Stop use during a teammate's turn", () => {
  render(
    <ComposerSendCluster
      cluster={{ kind: "turn", stop: true, enter: "now", other: { way: "queue", blocked: null } }}
      canSend
      block={null}
      stopping={false}
      payer={payer}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Send now" }).getAttribute("data-tip")).toBe(payer.now);
  expect(screen.getByRole("button", { name: "Queue" }).getAttribute("data-tip")).toBe(payer.queue);
  expect(screen.getByRole("button", { name: "Stop" }).getAttribute("data-tip")).toBe("Stop Mara's turn");
});

it("dims Queue with the reader's own refusal while Send now still joins", () => {
  render(
    <ComposerSendCluster
      cluster={{ kind: "turn", stop: true, enter: "now", other: { way: "queue", blocked: "You're out of cloud hours." } }}
      canSend
      block={null}
      stopping={false}
      payer={payer}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />,
  );
  const queue = screen.getByRole("button", { name: "Queue" });
  expect([queue.hasAttribute("disabled"), queue.getAttribute("data-tip")]).toEqual([true, "You're out of cloud hours."]);
  expect(screen.getByRole("button", { name: "Send now" }).hasAttribute("disabled")).toBe(false);
});

it("says Send uses the reader's own sign-in and hours with nothing running, and keeps today's words without a payer", () => {
  const { rerender } = render(
    <ComposerSendCluster
      cluster={{ kind: "send", stop: false, startsTask: false }}
      canSend
      block={null}
      stopping={false}
      payer={{ ...payer, now: null, queue: null, stop: null, send: "Uses your sign-in and hours." }}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("data-tip")).toBe("Uses your sign-in and hours.");
  rerender(<ComposerSendCluster cluster={{ kind: "send", stop: false, startsTask: false }} canSend block={null} stopping={false} onSend={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Send" }).getAttribute("data-tip")).toBe("Send");
  rerender(
    <ComposerSendCluster cluster={{ kind: "turn", stop: true, enter: "now", other: { way: "queue", blocked: null } }} canSend block={null} stopping={false} onSend={vi.fn()} onStop={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Queue" }).getAttribute("data-tip")).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" }).getAttribute("data-tip")).toBe("Stop");
});

it("keeps only Stop and the arrow while the message is dictated, the arrow still named for its way", () => {
  render(
    <ComposerSendCluster cluster={{ kind: "turn", stop: true, enter: "now", other: { way: "queue", blocked: null } }} canSend block={null} stopping={false} quiet onSend={vi.fn()} onStop={vi.fn()} />,
  );
  expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  const arrow = screen.getByRole("button", { name: "Send now" });
  expect(arrow.hasAttribute("data-words")).toBe(false);
  expect(arrow.getAttribute("data-tip")).toBe("Send now");
});

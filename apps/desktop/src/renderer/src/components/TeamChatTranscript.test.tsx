import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingTeamMessage, TeamMessage } from "@openorc/protocol";
import { TeamChatTranscript } from "./TeamChatTranscript";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the latest message in view through resize but leaves a reader's older position alone", () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(notify: () => void) {
        resize = notify;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const view = render(
    <TeamChatTranscript
      conversationId="general"
      messages={[]}
      pending={[]}
      self="self"
      people={[]}
      names={false}
      reason={null}
      older={false}
      loadingOlder={false}
      onOlder={() => {}}
      onReact={() => {}}
      onRetry={() => {}}
    />,
  );
  const viewport = view.container.querySelector<HTMLElement>(".team-chat-scroll")!;
  let height = 900;
  let windowHeight = 600;
  let top = 300;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => windowHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, height - windowHeight);
      },
    },
  });
  fireEvent.scroll(viewport);
  windowHeight = 400;
  act(resize);
  expect(top).toBe(500);
  height = 1100;
  act(resize);
  expect(top).toBe(700);
  viewport.scrollTop = 150;
  fireEvent.scroll(viewport);
  windowHeight = 300;
  act(resize);
  expect(top).toBe(150);
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("draws a send in the person's own run at once and keeps that bubble when the server confirms it", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const me = { id: "self", name: "Alex", image: null };
  const said = (id: string, seq: number, body: string): TeamMessage => ({
    id,
    channelId: "general",
    seq,
    actor: { kind: "person", person: me },
    body,
    files: [],
    reactions: [],
    replyTo: null,
    pinned: null,
    call: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const pending: PendingTeamMessage = { id: "b", body: "On my way", files: [], replyTo: null, orcling: null, createdAt: "2026-01-01T00:00:01.000Z", state: "sending", error: null };
  const props = { conversationId: "general", self: "self", people: [me], names: false, reason: null, older: false, loadingOlder: false, onOlder() {}, onReact() {}, onRetry() {} };
  const view = render(<TeamChatTranscript {...props} messages={[said("a", 1, "Hi")]} pending={[pending]} />);
  const runs = view.container.querySelectorAll(".team-chat-run");
  expect(runs).toHaveLength(1);
  const unsent = runs[0]!.querySelector<HTMLElement>('[data-message-id="b"]')!;
  expect(unsent.dataset["sending"]).toBe("sending");
  view.rerender(<TeamChatTranscript {...props} messages={[said("a", 1, "Hi"), said("b", 2, "On my way")]} pending={[]} />);
  const confirmed = view.container.querySelector<HTMLElement>('[data-message-id="b"]')!;
  expect(confirmed.querySelector(".orcling-bubble")).toBe(unsent.querySelector(".orcling-bubble"));
  expect(confirmed.dataset["sending"]).toBeUndefined();
});

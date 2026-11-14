import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
    <TeamChatTranscript messages={[]} pending={[]} self="self" people={[]} names={false} reason={null} older={false} loadingOlder={false} onOlder={() => {}} onReact={() => {}} onRetry={() => {}} />,
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

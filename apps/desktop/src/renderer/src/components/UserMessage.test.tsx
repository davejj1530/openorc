import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageMarks } from "./MarkedText";
import { UserMessage } from "./UserMessage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const marks = {
  commands: [{ name: "code-review", hint: "Review the branch for bugs", insert: true as const, prefix: "/" as const }],
  connectors: [{ name: "figma", title: "Figma", logo: "data:image/png;base64,AAAA" }],
};

it("draws a sent message as the composer did: the skill in blue, the connector's @ as its image, and says what the skill is for", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.dataset["skill"] ? [new DOMRect(10, 10, 80, 16)] : []) as unknown as DOMRectList;
  });
  if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
  const { container } = render(
    <MessageMarks.Provider value={marks}>
      <UserMessage text="run /code-review on the @figma file" />
    </MessageMarks.Provider>,
  );
  const bubble = container.querySelector<HTMLElement>(".message-bubble")!;
  expect(bubble.textContent).toBe("run /code-review on the @figma file");
  expect(bubble.querySelector("mark.skill-token")?.textContent).toBe("/code-review");
  expect(bubble.querySelector<HTMLElement>("mark.connector-token .connector-token-at")?.style.backgroundImage).toContain("data:image/png");
  fireEvent.pointerMove(bubble, { clientX: 30, clientY: 15 });
  await act(async () => void vi.advanceTimersByTime(400));
  expect(screen.getByText("Review the branch for bugs")).toBeTruthy();
});

it("leaves a message that names nothing as plain words", () => {
  const { container } = render(
    <MessageMarks.Provider value={marks}>
      <UserMessage text="just a note about /tmp files" />
    </MessageMarks.Provider>,
  );
  expect(container.querySelector(".message-bubble mark")).toBeNull();
});

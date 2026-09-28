import { lazy, Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RichText } from "./RichText";

vi.mock("@streamdown/code", () => ({ createCodePlugin: () => ({}) }));
vi.mock("@streamdown/math", () => ({ math: {} }));
vi.mock("streamdown", () => {
  const HighlightedBody = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: highlighted-body.js")));
  return {
    Streamdown: ({ children }: { children: string }) =>
      children.includes("```") ? (
        <Suspense fallback="Loading code">
          <HighlightedBody />
        </Suspense>
      ) : (
        <div>{children}</div>
      ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps the conversation and complete message readable when a lazy formatter fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const text = "Release instructions\n\n```sh\ngh release create v0.1.0\n```";
  const conversation = (message: string) => (
    <>
      <RichText>A neighboring reply</RichText>
      <RichText>{message}</RichText>
      <textarea aria-label="Message" />
    </>
  );
  const { rerender } = render(conversation(text));
  const fallback = await screen.findByText("Release instructions", { exact: false });
  expect(fallback.textContent).toBe(text);
  expect(screen.getByText("A neighboring reply")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  rerender(conversation(text + "\nMore instructions arrived."));
  expect(screen.getByText("Release instructions", { exact: false }).textContent).toBe(text + "\nMore instructions arrived.");
});

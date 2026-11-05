import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ThreadMedia, ThreadRichText } from "./ThreadImages";

afterEach(cleanup);

it("shows a local image an agent puts in its reply inline", async () => {
  render(
    <ThreadMedia scopeKey="thread">
      <ThreadRichText>{"Here is the Royal direction:\n\n![Royal](/tmp/brand-identity/palettes/royal-project.jpg)"}</ThreadRichText>
    </ThreadMedia>,
  );
  const image = await screen.findByRole("img", { name: "Royal" });
  expect(image.getAttribute("src")).toBe(`openorc-asset://local-image/?path=${encodeURIComponent("/tmp/brand-identity/palettes/royal-project.jpg")}`);
  expect(screen.getByRole("button", { name: "View image: Royal" })).toBeTruthy();
});

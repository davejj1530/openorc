import { expect, it } from "vitest";
import { cn } from "./cn";

it("treats the desktop's type steps as sizes and its roles as colors", () => {
  expect(cn("font-sans text-base text-ink", "text-title-sm")).toBe("font-sans text-ink text-title-sm");
  expect(cn("text-base text-ink", "text-md text-ink-3")).toBe("text-md text-ink-3");
  expect(cn("text-sm text-ink-4", "text-warn")).toBe("text-sm text-warn");
});

it("treats the phone's own wordmark step as a size", () => {
  expect(cn("font-sans text-base text-ink", "text-wordmark")).toBe("font-sans text-ink text-wordmark");
});

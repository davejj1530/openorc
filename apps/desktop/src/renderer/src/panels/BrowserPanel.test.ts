import { describe, expect, it } from "vitest";
import { typedUrl } from "./BrowserPanel";

describe("preview address", () => {
  it("reads an empty field as no address at all, which is what stops the submit", () => {
    expect(typedUrl("")).toBeNull();
    expect(typedUrl("   \t \n ")).toBeNull();
  });
  it("trims before it decides, so a pasted address does not collect a second scheme", () => {
    expect(typedUrl("  https://example.com  ")).toBe("https://example.com");
    expect(typedUrl(" localhost:3000 ")).toBe("http://localhost:3000");
  });
});

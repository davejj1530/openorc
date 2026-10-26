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
  it("leaves a path or a file URL as typed, for the pane to refuse, instead of looking it up as a website", () => {
    expect(typedUrl("file:///Users/me/dev/site/index.html")).toBe("file:///Users/me/dev/site/index.html");
    expect(typedUrl("/Users/me/notes/plan.html")).toBe("/Users/me/notes/plan.html");
    expect(typedUrl("~/notes/plan.html")).toBe("~/notes/plan.html");
    expect(typedUrl("example.com/a/b")).toBe("http://example.com/a/b");
  });
});

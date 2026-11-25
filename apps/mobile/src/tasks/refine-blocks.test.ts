import { describe, expect, it } from "vitest";
import { specBlocks, suggestionBlocks } from "./refine-blocks";

describe("a suggested description's blocks", () => {
  it("parts a description at blank lines and keeps a fenced block whole", () => {
    expect(specBlocks("## Goal\nStop the flake.\n\n\n```sh\npnpm test\n\npnpm lint\n```\n\n- [ ] Passes").map((block) => block.text)).toEqual([
      "## Goal\nStop the flake.",
      "```sh\npnpm test\n\npnpm lint\n```",
      "- [ ] Passes",
    ]);
  });

  it("marks what the suggestion adds, rewords and drops, in its own order", () => {
    const base = "## Goal\n\nStop the checkout test failing when the sandbox is slow.\n\nAsk Sam first.";
    const suggestion = "## Goal\n\nStop the checkout test failing when the payment sandbox answers late.\n\n## Scope\n\nOne retry with a short backoff.";
    expect(suggestionBlocks(base, suggestion)).toEqual([
      { kind: "same", text: "## Goal" },
      { kind: "removed", text: "Ask Sam first." },
      { kind: "changed", text: "Stop the checkout test failing when the payment sandbox answers late." },
      { kind: "added", text: "## Scope" },
      { kind: "added", text: "One retry with a short backoff." },
    ]);
  });
});

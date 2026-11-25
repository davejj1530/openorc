import { describe, expect, it } from "vitest";
import { quotedMessage, quoteRuns } from "./quotes";

describe("a message that quotes passages", () => {
  const quotes = [
    { id: "a", text: "The test times out.\n\nIt waits on the sandbox.", note: "Is this the cause?" },
    { id: "b", text: "A second timeout still fails.", note: "" },
  ];

  it("writes each passage quoted with its note under it, then the words", () => {
    expect(quotedMessage(quotes, "Retry it once.")).toBe("> The test times out.\n>\n> It waits on the sandbox.\nIs this the cause?\n\n> A second timeout still fails.\n\nRetry it once.");
    expect(quotedMessage([], "Retry it once.")).toBe("Retry it once.");
    expect(quotedMessage([quotes[1]!], "")).toBe("> A second timeout still fails.");
  });

  it("reads the passages back apart from the words between them", () => {
    expect(quoteRuns(quotedMessage(quotes, "Retry it once."))).toEqual([
      { quote: true, text: "The test times out.\n\nIt waits on the sandbox." },
      { quote: false, text: "Is this the cause?\n" },
      { quote: true, text: "A second timeout still fails." },
      { quote: false, text: "\nRetry it once." },
    ]);
  });
});

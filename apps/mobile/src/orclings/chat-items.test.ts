import { chatRows, type Block } from "@openorc/client";
import { defaultOrclingLook } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { bubbleTint, chatItems } from "./chat-items";

const message = (id: string, role: "user" | "assistant", text: string, at: number): Block => ({ id, kind: "message", role, text, streaming: false, at, runId: "run" });
const outline = (blocks: Block[], typing = false) =>
  chatItems(chatRows(blocks), typing).map((item) => (item.kind === "bubble" ? `bubble${item.first ? "+face" : ""}${item.last ? ".last" : ""}@${item.gap}` : `${item.kind}@${item.gap}`));

describe("chatItems", () => {
  it("gives each paragraph of the Orcling's its own bubble, the face beside the first of a run, and runs apart from the person's messages", () => {
    const blocks = [message("a", "user", "Anything new?", 1000), message("b", "assistant", "Two things.\n\nThe build is green.", 2000), message("c", "assistant", "And a review waits.", 3000)];
    expect(outline(blocks)).toEqual(["time@8", "mine@14", "bubble+face@14", "bubble@3", "bubble.last@3"]);
  });

  it("puts the typing dots at the end of a run while the Orcling works, with its face when they start one", () => {
    expect(outline([message("b", "assistant", "On it.", 2000)], true)).toEqual(["time@8", "bubble+face@14", "typing@3"]);
    expect(outline([message("a", "user", "Hi", 1000)], true)).toEqual(["time@8", "mine@14", "typing@14"]);
  });
});

describe("bubbleTint", () => {
  it("tints the body color 14% over a light ground and 20% over a dark one", () => {
    const body = defaultOrclingLook.bodyColor;
    expect(bubbleTint(body, "light")).toBe(`${body}24`);
    expect(bubbleTint(body, "dark")).toBe(`${body}33`);
  });
});

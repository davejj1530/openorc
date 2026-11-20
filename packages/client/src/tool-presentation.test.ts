import { describe, expect, it } from "vitest";
import { toolCallPresentation } from "./tool-presentation.js";

const server = "openorc_0123456789abcdef0123456789abcdef";

describe("MCP tool calls", () => {
  it("names OpenOrc's own tools the same in every agent's naming", () => {
    for (const name of [`mcp__${server}__custom_thing`, `${server}_custom_thing`, `mcp__${server}_custom_thing`]) {
      expect(toolCallPresentation(name, {})).toMatchObject({ verb: "OpenOrc: custom thing", summary: "Used OpenOrc" });
    }
  });

  it("reads another server of Oh My Pi's by its name's first word", () => {
    expect(toolCallPresentation("mcp__codegraph_explore", {})).toMatchObject({ verb: "Codegraph: explore", summary: "Used Codegraph" });
  });
});

describe("OpenOrc's own tools", () => {
  it("says what the browser did, and where it went when it opened a page", () => {
    expect(toolCallPresentation("openorc.browser", { action: "open", url: "https://kindui.dev/#agent-ui" })).toMatchObject({ icon: "Globe", verb: "Opened", object: "kindui.dev/#agent-ui" });
    expect(toolCallPresentation(`mcp__${server}__browser`, { action: "screenshot" })).toMatchObject({ verb: "Took a screenshot", object: "" });
    expect(toolCallPresentation("openorc.browser", { action: "snapshot" })).toMatchObject({ verb: "Read the page" });
  });

  it("names a message by how it starts, and the thread tools by what they do", () => {
    expect(toolCallPresentation("openorc.thread_send", { id: "t1", text: "One question about the server half.\nAnswer when you pause." })).toMatchObject({
      icon: "WorkMessage",
      verb: "Sent message",
      object: "One question about the server half.",
    });
    expect(toolCallPresentation("openorc.thread_list", {})).toMatchObject({ verb: "Listed threads", object: "" });
    expect(toolCallPresentation("openorc.thread_read", { id: "t1" })).toMatchObject({ verb: "Read thread" });
    expect(toolCallPresentation("openorc.thread_start", { prompt: "Draw the icons", title: "Icons" })).toMatchObject({ verb: "Started thread", object: "Icons" });
    expect(toolCallPresentation("ExitPlanMode", {})).toMatchObject({ verb: "Proposed a plan" });
  });
});

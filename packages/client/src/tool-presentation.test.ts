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

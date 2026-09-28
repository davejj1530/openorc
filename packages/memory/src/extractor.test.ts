import { describe, expect, it } from "vitest";
import { parseExtraction, parseTitle } from "./extractor.js";
import { digestRun, renderDigest } from "./transcript.js";
import type { AgentEvent } from "@openorc/protocol";

describe("parseExtraction", () => {
  it("parses clean JSON", () => {
    const e = parseExtraction(
      '{"summary":{"request":"add csv","workDone":"wrote writer","outcome":"success","openItems":["tests"]},"memories":[{"type":"lesson","title":"Escape quotes","body":"double them","topicKey":"csv/escape","files":["src/export.ts"],"confidence":0.8}]}',
    );
    expect(e?.summary.outcome).toBe("success");
    expect(e?.memories[0]?.type).toBe("lesson");
    expect(e?.memories[0]?.topicKey).toBe("csv/escape");
  });

  it("tolerates code fences and surrounding prose", () => {
    const e = parseExtraction('Here you go:\n```json\n{"summary":{"request":"x","workDone":"y","outcome":"partial","openItems":[]},"memories":[]}\n```\nDone.');
    expect(e?.summary.outcome).toBe("partial");
    expect(e?.memories).toHaveLength(0);
  });

  it("coerces bad types and caps counts", () => {
    const mems = Array.from({ length: 10 }, (_, i) => `{"type":"nope","title":"t${i}","body":"b${i}","confidence":9}`).join(",");
    const e = parseExtraction(`{"summary":{},"memories":[${mems}]}`);
    expect(e?.memories.length).toBe(6);
    expect(e?.memories[0]?.type).toBe("lesson");
    expect(e?.memories[0]?.confidence).toBeLessThanOrEqual(1);
    expect(e?.summary.outcome).toBe("unknown");
  });

  it("skips malformed memory entries and tolerates an invalid summary without throwing", () => {
    const e = parseExtraction('{"summary":null,"memories":[null,[],"bad",{"type":"decision","title":" Retain the result ","body":"Observed","confidence":1e999}]}');
    expect(e?.summary).toEqual({ request: "", workDone: "", outcome: "unknown", openItems: [] });
    expect(e?.memories).toEqual([{ type: "decision", title: "Retain the result", body: "Observed", topicKey: null, files: [], confidence: 0.6 }]);
  });

  it("returns null on garbage", () => {
    expect(parseExtraction("not json at all")).toBeNull();
    expect(parseExtraction("")).toBeNull();
  });
});

describe("digestRun", () => {
  it("pulls prompts, assistant text, tool outcomes, and files", () => {
    const events: AgentEvent[] = [
      { type: "message.completed", runId: "r", ts: 1, messageId: "u1", role: "user", text: "add export" },
      { type: "tool.started", runId: "r", ts: 2, toolCallId: "t1", name: "Bash", input: {}, parentToolCallId: null },
      { type: "tool.completed", runId: "r", ts: 3, toolCallId: "t1", name: "Bash", output: "ok", isError: false },
      { type: "file.changed", runId: "r", ts: 4, path: "src/export.ts", kind: "add" },
      { type: "message.completed", runId: "r", ts: 5, messageId: "a1", role: "assistant", text: "Done." },
    ];
    const d = digestRun(events);
    expect(d.prompts).toEqual(["add export"]);
    expect(d.filesTouched).toEqual(["add src/export.ts"]);
    expect(d.toolLines[0]).toContain("Bash: ok");
    expect(renderDigest(d)).toContain("## Files changed");
  });
});

describe("parseTitle", () => {
  it("reads the title out of JSON, with or without fences", () => {
    expect(parseTitle('{"title":"Sidebar collapse and traffic lights"}')).toBe("Sidebar collapse and traffic lights");
    expect(parseTitle('```json\n{"title":"CSV export filters"}\n```')).toBe("CSV export filters");
  });

  it("returns null when there is nothing usable", () => {
    expect(parseTitle('{"title":""}')).toBeNull();
    expect(parseTitle("")).toBeNull();
  });
});

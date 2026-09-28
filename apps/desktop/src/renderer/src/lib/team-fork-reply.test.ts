import { describe, expect, it } from "vitest";
import type { Block } from "./transcript";
import { teamForkReplyId } from "./team-fork-reply";

const reply = (id: string, streaming = false): Block => ({ id, kind: "message", role: "assistant", text: `Reply ${id}`, streaming });
const finished: Block = { id: "turn-first", kind: "status", tone: "ok", text: "turn finished in 1s" };

describe("team lead reply fork position", () => {
  it("does not treat streaming, failed, system, or user messages as completed lead replies", () => {
    expect(teamForkReplyId([reply("stream", true)])).toBeNull();
    expect(teamForkReplyId([reply("partial"), { ...finished, tone: "bad", text: "turn error" }])).toBeNull();
    expect(teamForkReplyId([{ id: "input", kind: "message", role: "user", text: "Direction", streaming: false }, finished])).toBeNull();
    expect(teamForkReplyId([{ id: "system", kind: "message", role: "system", text: "Notice", streaming: false }, finished])).toBeNull();
    expect(teamForkReplyId([{ id: "api", kind: "message", role: "assistant", text: "API Error: unavailable", streaming: false }, finished])).toBeNull();
  });

  it("keeps the retained completed boundary when later output is partial", () => {
    expect(teamForkReplyId([reply("completed"), finished, reply("later", true)])).toBe("completed");
    expect(teamForkReplyId([reply("completed"), finished, reply("next"), { ...finished, id: "turn-next" }])).toBe("next");
  });
});

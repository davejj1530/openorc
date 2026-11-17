import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { packSession, unpackSession } from "./session-pack.js";
import { sessionId, type PackedSession } from "./session-slot.js";

const saved: PackedSession = {
  agent: "claude",
  format: 1,
  cliVersion: "2.1.322",
  sessionId: sessionId("4f0c2a5e-0b8e-4d4c-9a51-7d3b1c2e9f10")!,
  parts: [
    { name: "session.jsonl", bytes: Buffer.from('{"type":"user"}\n') },
    { name: "subagents/agent-a1.jsonl", bytes: Buffer.from('{"type":"assistant"}\n') },
  ],
  meta: { selected: "x" },
};

describe("a session packed as OpenOrc Cloud keeps it", () => {
  it("is a gzipped first line naming every part, then the parts, and unpacks to the same session", () => {
    const packed = packSession(saved);
    const all = gunzipSync(packed).toString("utf8");
    const [first] = all.split("\n");
    expect(JSON.parse(first!)).toEqual({
      agent: "claude",
      format: 1,
      cliVersion: "2.1.322",
      sessionId: saved.sessionId,
      meta: { selected: "x" },
      parts: [
        { name: "session.jsonl", bytes: 16, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { name: "subagents/agent-a1.jsonl", bytes: 21, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    expect(unpackSession(packed)).toEqual(saved);
  });

  it("refuses bytes that are not the parts their first line names", () => {
    const all = gunzipSync(packSession(saved));
    const tampered = Buffer.from(all.toString("utf8").replace('{"type":"user"}', '{"type":"evil"}'));
    expect(() => unpackSession(gzipSync(tampered))).toThrow("is not the bytes it names");
    expect(() => unpackSession(gzipSync(Buffer.from("no first line")))).toThrow("has no first line");
  });
});

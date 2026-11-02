import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SealedUnreadable } from "./sealed-file.js";
import {
  BrainWireError,
  brainKeyFrom,
  brainKeyText,
  encodeControlReply,
  encodeLaunch,
  newBrainKey,
  openHandover,
  parseControlReply,
  parseControlRequest,
  parseLaunch,
  sealHandover,
  type BrainControlRequest,
  type BrainStart,
} from "./wire.js";

const TOKEN = "vcp_7f3k2m9q8w1e4r6t5y0uSECRET";

function start(overrides: Partial<BrainStart> = {}): BrainStart {
  return {
    key: newBrainKey(),
    name: "Cloud",
    address: "sb-abc123.vercel.run",
    port: 47_820,
    vercel: { connection: { token: TOKEN, teamId: "team_1", projectId: "prj_1", vcpus: 2 }, sandbox: "brain" },
    ...overrides,
  };
}

/** The start line as JSON, with one field set to something else. */
function lineWith(path: string[], value: unknown, base = start()): string {
  const wire = JSON.parse(encodeLaunch(base)) as Record<string, unknown>;
  let at = wire;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[path.at(-1)!] = value;
  return JSON.stringify(wire);
}

function refusal(parse: () => unknown): BrainWireError {
  try {
    parse();
  } catch (error) {
    if (error instanceof BrainWireError) return error;
    throw error;
  }
  throw new Error("expected a BrainWireError");
}

describe("the brain's start line", () => {
  it("reads back what the waker wrote, with or without Vercel", () => {
    for (const sent of [start(), start({ vercel: null })]) {
      const read = parseLaunch(encodeLaunch(sent));
      expect(brainKeyText(read.key)).toBe(brainKeyText(sent.key));
      expect({ ...read, key: null }).toEqual({ ...sent, key: null });
    }
  });

  it("names the bad field and never repeats a value, even one that holds the token or the key", () => {
    const base = start();
    const keyText = brainKeyText(base.key);
    const cases: [string, string][] = [
      [`{"v":1,"key":"${keyText}","vercel":{"connection":{"token":"${TOKEN}"`, "line"],
      [`{"v":1,"vercel":{"connection":{"token":${TOKEN}}}}`, "line"],
      [TOKEN, "line"],
      [lineWith(["key"], keyText.slice(1), base), "key"],
      [lineWith(["key"], `${keyText.slice(0, -1)}B`, base), "key"],
      [lineWith(["address"], `https://${TOKEN}@sb.vercel.run`, base), "address"],
      [lineWith(["port"], 0, base), "port"],
      [lineWith(["v"], 2, base), "v"],
      [lineWith(["vercel", "connection", "token"], "", base), "vercel.connection.token"],
      [lineWith(["vercel", "connection", "teamId"], { token: TOKEN }, base), "vercel.connection.teamId"],
      [lineWith(["vercel", "connection", TOKEN], keyText, base), "vercel.connection"],
      [lineWith([TOKEN], keyText, base), ""],
      [JSON.stringify([TOKEN]), ""],
    ];
    for (const [line, field] of cases) {
      const error = refusal(() => parseLaunch(line));
      expect(error.field).toBe(field);
      expect(error.message).toMatch(/^The brain's start line is not valid: /);
      const everything = inspect(error, { depth: 5 });
      // JSON.parse quotes about ten characters around its error, so even a token's first few must not appear.
      expect(everything).not.toContain(TOKEN.slice(0, 8));
      expect(everything).not.toContain(keyText);
      expect(everything).not.toContain(keyText.slice(1));
    }
  });
});

describe("brain keys", () => {
  it("round-trips its text and refuses any text that is not exactly 32 bytes in canonical base64url", () => {
    const key = newBrainKey();
    expect(brainKeyText(brainKeyFrom(brainKeyText(key)))).toBe(brainKeyText(key));
    const text = brainKeyText(key);
    // "B" sets one of the last character's two unused bits: the same bytes, but not the key's own text.
    for (const bad of ["", text.slice(1), `${text}A`, `${text.slice(0, -1)}B`, `${text.slice(0, -1)}=`, `+${text.slice(1)}`]) {
      expect(() => brainKeyFrom(bad)).toThrow(BrainWireError);
    }
  });
});

describe("control requests and replies", () => {
  it("parses every request the waker can send", () => {
    const requests: BrainControlRequest[] = [
      { op: "status" },
      { op: "wake" },
      { op: "pair" },
      { op: "handover", sealed: { claude: "AAAA" } },
      { op: "import-project", name: "openorc", bundle: "openorc-1.bundle", origin: "git@github.com:me/openorc.git" },
      { op: "stop" },
      { op: "stop-for-update" },
    ];
    for (const request of requests) expect(parseControlRequest(JSON.stringify(request))).toEqual(request);
  });

  it("reads what a Mac and a brain one version apart write, in either direction", () => {
    // As the version before dated brains wrote them, and as a newer one writes every line whose shape stayed.
    const key = "A".repeat(43);
    const start = `{"v":1,"key":"${key}","name":"Cloud","address":"sb-abc123.vercel.run","port":47820,"vercel":{"connection":{"token":"vcp_x","teamId":"team_1","projectId":"prj_1"},"sandbox":"brain"}}`;
    expect(parseLaunch(start)).toMatchObject({ name: "Cloud", address: "sb-abc123.vercel.run", port: 47_820, vercel: { sandbox: "brain" } });
    const requests = [
      '{"op":"status"}',
      '{"op":"wake"}',
      '{"op":"pair"}',
      '{"op":"handover","sealed":{"claude":"AAAA"}}',
      '{"op":"import-project","name":"demo","bundle":"demo.bundle","origin":"https://github.com/me/demo.git"}',
      '{"op":"stop"}',
    ];
    for (const line of requests) expect(parseControlRequest(line)).toEqual(JSON.parse(line));
    const replies: [BrainControlRequest["op"], string][] = [
      ["status", '{"ok":true,"result":{"state":"ready","version":"eed2a8309f9a","pid":7,"since":1,"busy":null}}'],
      ["wake", '{"ok":true,"result":{"state":"closing","version":"20261102120000-eed2a8309f9a","pid":7,"since":1,"busy":"agents"}}'],
      ["pair", '{"ok":true,"result":{"url":"openorc://pair#v1.x","expiresAt":5}}'],
      ["handover", '{"ok":true,"result":{"applied":["claude"]}}'],
      ["import-project", '{"ok":true,"result":{"projectId":"p"}}'],
      ["stop", '{"ok":true,"result":{"stopping":true}}'],
      ["stop", `{"ok":false,"error":"The brain's control request is not valid: it has an unknown field."}`],
    ];
    for (const [op, line] of replies) expect(parseControlReply(op, line)).toEqual(JSON.parse(line));
  });

  it("refuses an unknown op, an extra field, and a bundle outside the inbox", () => {
    expect(refusal(() => parseControlRequest(`{"op":"shell"}`)).field).toBe("op");
    expect(refusal(() => parseControlRequest(`{"op":"pair","now":true}`)).message).toContain("it has an unknown field");
    expect(refusal(() => parseControlRequest(`{"op":"import-project","name":"x","bundle":"../data/secrets/remote.sealed"}`)).field).toBe("bundle");
  });

  it("reads the brain's answer for the op it was asked, or its refusal", () => {
    const status = { state: "ready", version: "brain-3f2a9c1d00ab", pid: 41, since: 1_700_000_000_000, busy: null } as const;
    expect(parseControlReply("status", encodeControlReply({ ok: true, result: status }))).toEqual({ ok: true, result: status });
    expect(parseControlReply("wake", encodeControlReply({ ok: true, result: status }))).toEqual({ ok: true, result: status });
    expect(parseControlReply("pair", encodeControlReply({ ok: false, error: "Phone access is off." }))).toEqual({ ok: false, error: "Phone access is off." });
    expect(refusal(() => parseControlReply("status", JSON.stringify({ ok: true, result: { ...status, state: "asleep" } }))).field).toBe("result.state");
    expect(refusal(() => parseControlReply("stop", JSON.stringify({ ok: true, result: status }))).message).toContain("result has an unknown field");
  });
});

const work = { id: "4c1f0a52-7a0e-4b44-9d7e-1f0c2a6b8e11", name: "Work", default: false, token: "sk-ant-oat01-work-abcdefghijklmnopqrstuvwxyz" };
const personal = { id: "claude-cli", name: "Personal", default: true, token: "sk-ant-oat01-personal-abcdefghijklmnopqrstuvwxyz" };

describe("handovers", () => {
  it("carry each sign-in sealed under the brain key, never in the clear", () => {
    const key = newBrainKey();
    const handover = { claude: { accounts: [personal, work] }, push: { keyId: "ABC123DEFG", pem: "-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----" } };
    const line = JSON.stringify(sealHandover(key, handover));
    expect(line).not.toContain("sk-ant-oat01");
    expect(line).not.toContain("PRIVATE KEY");
    const request = parseControlRequest(line);
    if (request.op !== "handover") throw new Error("expected a handover");
    expect(Object.keys(request.sealed).sort()).toEqual(["claude", "push"]);
    expect(openHandover(key, request)).toEqual({ ...handover, codex: undefined });
    expect(() => openHandover(newBrainKey(), request)).toThrow(SealedUnreadable);
  });

  it("will not open one kind's sealed value as another's", () => {
    const key = newBrainKey();
    const sealed = sealHandover(key, { claude: { accounts: [personal] } }).sealed.claude!;
    expect(() => openHandover(key, { op: "handover", sealed: { codex: sealed } })).toThrow(SealedUnreadable);
  });

  it("carry an empty Claude list, which signs every account out on the brain", () => {
    const key = newBrainKey();
    expect(openHandover(key, sealHandover(key, { claude: { accounts: [] } })).claude).toEqual({ accounts: [] });
  });

  it("refuse a Claude list with one id twice or two defaults, without repeating a token", () => {
    const key = newBrainKey();
    for (const accounts of [
      [work, { ...work, name: "Work again" }],
      [personal, { ...work, default: true }],
    ]) {
      const error = refusal(() => openHandover(key, sealHandover(key, { claude: { accounts } })));
      expect(error.field).toBe("accounts");
      expect(error.message).not.toContain("sk-ant-oat01");
    }
  });
});

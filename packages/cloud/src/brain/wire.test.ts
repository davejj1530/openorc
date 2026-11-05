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
  signInPrint,
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
      { op: "import-project", source: "4c1f0a52-7a0e-4b44-9d7e-1f0c2a6b8e11", name: "My App (2)", branch: "main", bundle: "openorc-1.bundle", origin: "git@github.com:me/openorc.git" },
      { op: "import-project", source: "p1", name: ".dotfiles", branch: "release/v2", bundle: "p1.bundle" },
      { op: "remove-project", source: "4c1f0a52-7a0e-4b44-9d7e-1f0c2a6b8e11" },
      { op: "projects" },
      { op: "project-settings", source: "p1", settings: { setupScript: "pnpm install\npnpm build", branchPrefix: "", worktreeInclude: [".env"] } },
      { op: "project-settings", source: "p1", settings: { setupScript: null, branchPrefix: "openorc", worktreeInclude: [] } },
      { op: "stop" },
      { op: "stop-for-update" },
    ];
    for (const request of requests) expect(parseControlRequest(JSON.stringify(request))).toEqual(request);
    expect(parseControlReply("project-settings", JSON.stringify({ ok: true, result: { applied: false } }))).toEqual({ ok: true, result: { applied: false } });
  });

  it("reads what a Mac and a brain one version apart write, in either direction", () => {
    // As the version before dated brains wrote them, and as a newer one writes every line whose shape stayed.
    const key = "A".repeat(43);
    const start = `{"v":1,"key":"${key}","name":"Cloud","address":"sb-abc123.vercel.run","port":47820,"vercel":{"connection":{"token":"vcp_x","teamId":"team_1","projectId":"prj_1"},"sandbox":"brain"}}`;
    expect(parseLaunch(start)).toMatchObject({ name: "Cloud", address: "sb-abc123.vercel.run", port: 47_820, vercel: { sandbox: "brain" } });
    const requests = ['{"op":"status"}', '{"op":"wake"}', '{"op":"pair"}', '{"op":"handover","sealed":{"claude":"AAAA"}}', '{"op":"stop"}'];
    for (const line of requests) expect(parseControlRequest(line)).toEqual(JSON.parse(line));
    const replies: [BrainControlRequest["op"], string][] = [
      ["status", '{"ok":true,"result":{"state":"ready","version":"eed2a8309f9a","pid":7,"since":1,"busy":null}}'],
      ["wake", '{"ok":true,"result":{"state":"closing","version":"20261102120000-eed2a8309f9a","pid":7,"since":1,"busy":"agents"}}'],
      ["pair", '{"ok":true,"result":{"url":"openorc://pair#v1.x","expiresAt":5}}'],
      ["handover", '{"ok":true,"result":{"applied":["claude"]}}'],
      ["stop", '{"ok":true,"result":{"stopping":true}}'],
      ["stop", `{"ok":false,"error":"The brain's control request is not valid: it has an unknown field."}`],
    ];
    for (const [op, line] of replies) expect(parseControlReply(op, line)).toEqual(JSON.parse(line));
  });

  it("refuses an unknown op, an extra field, a bundle outside the inbox, and a project folder that is not one folder", () => {
    expect(refusal(() => parseControlRequest(`{"op":"shell"}`)).field).toBe("op");
    expect(refusal(() => parseControlRequest(`{"op":"pair","now":true}`)).message).toContain("it has an unknown field");
    const project = { op: "import-project", source: "p1", name: "x", branch: "main", bundle: "x.bundle" };
    expect(refusal(() => parseControlRequest(JSON.stringify({ ...project, bundle: "../data/secrets/remote.sealed" }))).field).toBe("bundle");
    for (const name of ["..", ".", "a/b", "a\\b", "tab\there", ""]) expect([name, refusal(() => parseControlRequest(JSON.stringify({ ...project, name }))).field]).toEqual([name, "name"]);
    for (const source of ["../p1", "p1/x", ""]) expect([source, refusal(() => parseControlRequest(JSON.stringify({ ...project, source }))).field]).toEqual([source, "source"]);
    expect(refusal(() => parseControlRequest(JSON.stringify({ ...project, branch: "-main" }))).field).toBe("branch");
  });

  it("reads a project's import, the copies the brain has, and a removal, with the brain's own head when it kept commits", () => {
    const [mac, own] = ["a".repeat(40), "b".repeat(40)];
    const imported = { projectId: "p", macHead: mac, head: own };
    expect(parseControlReply("import-project", encodeControlReply<"import-project">({ ok: true, result: imported }))).toEqual({ ok: true, result: imported });
    expect(parseControlReply("import-project", '{"ok":true,"result":{"lacksBase":true}}')).toEqual({ ok: true, result: { lacksBase: true } });
    expect(refusal(() => parseControlReply("import-project", '{"ok":true,"result":{"lacksBase":false}}')).field).toBe("result");
    const copies = { copies: [{ ...imported, source: "mac-p", threads: 2 }] };
    expect(parseControlReply("projects", encodeControlReply<"projects">({ ok: true, result: copies }))).toEqual({ ok: true, result: copies });
    expect(parseControlReply("remove-project", '{"ok":true,"result":{"removed":false,"threads":1}}')).toEqual({ ok: true, result: { removed: false, threads: 1 } });
    expect(refusal(() => parseControlReply("import-project", JSON.stringify({ ok: true, result: { ...imported, head: "main" } }))).field).toBe("result.head");
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

describe("the phones paired with the brain", () => {
  it("lists them and unpairs one by its device id, refusing an id that is not one", () => {
    const id = "0b6b8a5e-2f4c-4d2a-9c61-1f8e2d3c4b5a";
    expect(parseControlRequest(JSON.stringify({ op: "phones" }))).toEqual({ op: "phones" });
    expect(parseControlRequest(JSON.stringify({ op: "remove-phone", id }))).toEqual({ op: "remove-phone", id });
    for (const bad of ["", "../owner", "a b"]) expect([bad, refusal(() => parseControlRequest(JSON.stringify({ op: "remove-phone", id: bad }))).field]).toEqual([bad, "id"]);
    const phones = { phones: [{ id, name: "Pocket", createdAt: 1, lastSeenAt: null, connected: true }] };
    expect(parseControlReply("phones", encodeControlReply<"phones">({ ok: true, result: phones }))).toEqual({ ok: true, result: phones });
    expect(parseControlReply("remove-phone", encodeControlReply<"remove-phone">({ ok: true, result: { phones: [] } }))).toEqual({ ok: true, result: { phones: [] } });
    expect(refusal(() => parseControlReply("phones", JSON.stringify({ ok: true, result: { phones: [{ ...phones.phones[0], connected: "yes" }] } }))).field).toBe("result.phones[0].connected");
  });
});

describe("moving threads between the Mac and the brain", () => {
  const relocation = "6f1e2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";
  const threadId = "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

  it("parses each request and reads each answer, a refusal included", () => {
    const requests: BrainControlRequest[] = [
      { op: "identity" },
      { op: "receive-thread", relocation, package: `${relocation}.thread` },
      { op: "drop-arrival", relocation, threadId },
      { op: "hand-off-thread", relocation, threadId },
      { op: "cancel-hand-off", relocation, threadId },
      { op: "handed-off", relocation },
    ];
    for (const request of requests) expect(parseControlRequest(JSON.stringify(request))).toEqual(request);
    const answers: [BrainControlRequest["op"], unknown][] = [
      ["identity", { linkKey: "A".repeat(43) }],
      ["receive-thread", { received: true }],
      ["receive-thread", { refused: "This move was called off." }],
      ["receive-thread", { lacksBase: true }],
      ["drop-arrival", { dropped: true }],
      ["drop-arrival", { received: true }],
      ["hand-off-thread", { file: `${relocation}.thread`, bytes: 1024, sha256: "c".repeat(64) }],
      ["hand-off-thread", { refused: "Its agent is at work. Stop the turn, then move it." }],
      ["cancel-hand-off", { stayed: true }],
      ["cancel-hand-off", { left: true }],
      ["handed-off", { left: true }],
    ];
    for (const [op, result] of answers) expect(parseControlReply(op, JSON.stringify({ ok: true, result }))).toEqual({ ok: true, result });
  });

  it("refuses a package outside the inbox, an id that could name a path, and an answer it does not expect", () => {
    expect(refusal(() => parseControlRequest(JSON.stringify({ op: "receive-thread", relocation, package: "../outbox/x.thread" }))).field).toBe("package");
    expect(refusal(() => parseControlRequest(JSON.stringify({ op: "hand-off-thread", relocation: "../r", threadId }))).field).toBe("relocation");
    expect(refusal(() => parseControlRequest(JSON.stringify({ op: "drop-arrival", relocation, threadId: "a/b" }))).field).toBe("threadId");
    expect(refusal(() => parseControlReply("receive-thread", '{"ok":true,"result":{"received":false}}')).field).toBe("result.received");
    expect(refusal(() => parseControlReply("hand-off-thread", JSON.stringify({ ok: true, result: { file: "../x", bytes: 1, sha256: "c".repeat(64) } }))).field).toBe("result.file");
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

  it("carry the brain's own Codex login, the Mac's GitHub sign-in and push key, or null for each to take it away", () => {
    const key = newBrainKey();
    const codex = { id: "mac-login-1", mode: "chatgpt", auth: '{"tokens":{"refresh_token":"rt-fixture"}}', email: "qa@example.com", plan: null } as const;
    const github = { token: "gho_fixtureToken0123456789", name: "Fixture Person", email: null };
    const line = JSON.stringify(sealHandover(key, { codex, github, push: null }));
    expect(line).not.toMatch(/rt-fixture|gho_fixture|Fixture Person/);
    const request = parseControlRequest(line);
    if (request.op !== "handover") throw new Error("expected a handover");
    expect(Object.keys(request.sealed).sort()).toEqual(["codex", "github", "push"]);
    expect(openHandover(key, request)).toEqual({ claude: undefined, codex, github, push: null });
    expect(openHandover(key, sealHandover(key, { codex: null, github: null }))).toMatchObject({ codex: null, github: null });
  });

  it("name a sign-in the same on both sides whatever its keys' order, and the brain says what it holds by those names", () => {
    const github = { token: "gho_fixtureToken0123456789", name: "Fixture Person", email: null };
    expect(signInPrint({ email: null, name: "Fixture Person", token: "gho_fixtureToken0123456789" })).toBe(signInPrint(github));
    expect(signInPrint({ ...github, name: "Someone Else" })).not.toBe(signInPrint(github));
    expect(signInPrint(github)).not.toContain("gho_");
    const holds = { codex: "mac-login-1", github: signInPrint(github), push: "ABC123DEFG" };
    expect(parseControlRequest(JSON.stringify({ op: "sign-ins" }))).toEqual({ op: "sign-ins" });
    expect(parseControlReply("sign-ins", encodeControlReply({ ok: true, result: holds }))).toEqual({ ok: true, result: holds });
  });

  it("refuse a Codex login with an id the brain could not record, without repeating the login", () => {
    const key = newBrainKey();
    const error = refusal(() => openHandover(key, sealHandover(key, { codex: { id: "mac login/1", mode: "chatgpt", auth: "rt-fixture-secret", email: null, plan: null } })));
    expect(error.field).toBe("id");
    expect(error.message).not.toContain("rt-fixture-secret");
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

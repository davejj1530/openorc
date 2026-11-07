import { describe, expect, it } from "vitest";
import { codexConnectorRows, codexServerConfig } from "./codex/connectors.js";
import { readableConnectorError } from "./connectors.js";
import { editedOpenCodeConfig, openCodeServerConfig, savedOpenCodeServers } from "./opencode/connectors.js";

describe("connector errors", () => {
  it("keep a server's host and drop the rest of its address, where a token can sit", () => {
    expect(readableConnectorError("handshake failed: error sending request for url (http://127.0.0.1:44870/mcp/SECRETTOKEN), when send initialize")).toBe(
      "handshake failed: error sending request for url (127.0.0.1:44870), when send initialize",
    );
  });

  it("stop at the first line and a readable length", () => {
    expect(readableConnectorError(`${"x".repeat(400)}\nsecond line`)).toHaveLength(160);
  });
});

describe("Codex connectors", () => {
  const read = {
    config: { mcp_servers: { paper: { command: "paper" }, mobbin: { url: "https://mobbin.example/mcp" }, local: { command: "x", enabled: false } } },
    layers: [{ name: { type: "user" }, config: { mcp_servers: { paper: { command: "paper" }, mobbin: { url: "https://mobbin.example/mcp" }, local: { command: "x" } } } }],
  };

  it("read as the user's, a plugin's, signed out, failed or off", () => {
    const rows = codexConnectorRows(read, [
      { name: "paper", authStatus: "unsupported", tools: { a: {} } },
      { name: "mobbin", authStatus: "notLoggedIn", tools: {} },
      { name: "local", authStatus: "unsupported", tools: {} },
      { name: "figma", authStatus: "unsupported", tools: {}, toolsError: "MCP startup failed" },
      { name: "codex_apps", authStatus: "bearerToken", tools: { a: {} } },
    ]);
    expect(rows.map((row) => [row.name, row.source, row.kind, row.status])).toEqual([
      ["paper", "user", "command", "connected"],
      ["mobbin", "user", "url", "needs-sign-in"],
      ["local", "user", "command", "off"],
      ["figma", "plugin", null, "failed"],
    ]);
  });

  it("save over what was saved, keeping settings OpenOrc does not show", () => {
    expect(codexServerConfig({ command: "old", args: ["a"], enabled: false, tools: { x: { approval_mode: "approve" } } }, { kind: "url", url: "https://new.example/mcp", headers: {} })).toEqual({
      enabled: false,
      tools: { x: { approval_mode: "approve" } },
      url: "https://new.example/mcp",
      http_headers: {},
    });
  });
});

describe("OpenCode connectors", () => {
  it("are read from both the current and the earlier way of writing them", () => {
    const found = savedOpenCodeServers({ old: { type: "local", command: ["old"] }, servers: { paper: { type: "remote", url: "https://paper.example" } } });
    expect([...found].map(([name, { at }]) => [name, at])).toEqual([
      ["old", ["mcp", "old"]],
      ["paper", ["mcp", "servers", "paper"]],
    ]);
  });

  it("change one value and keep the user's comments", () => {
    const text = '{\n  // mine\n  "model": "x"\n}\n';
    const edited = editedOpenCodeConfig(text, ["mcp", "servers", "paper"], openCodeServerConfig(undefined, { kind: "command", command: "paper", args: ["--stdio"], env: {} }));
    expect(edited).toContain("// mine");
    expect(JSON.parse(edited.replace("// mine", ""))).toEqual({ model: "x", mcp: { servers: { paper: { type: "local", command: ["paper", "--stdio"] } } } });
  });

  it("save over what was saved, keeping settings OpenOrc does not show", () => {
    expect(openCodeServerConfig({ type: "local", command: ["old"], timeout: { connect: 5 }, disabled: true }, { kind: "url", url: "https://paper.example", headers: { key: "v" } })).toEqual({
      timeout: { connect: 5 },
      disabled: true,
      type: "remote",
      url: "https://paper.example",
      headers: { key: "v" },
    });
  });
});

describe("Codex mentions", () => {
  it("name only servers Codex has, once each, where @ starts a word", async () => {
    const { serverMentions } = await import("./codex/adapter.js");
    expect(serverMentions("use @paper and @paper, mail me@paper.com, ask @nobody", new Set(["paper"]))).toEqual([{ type: "mention", name: "paper", path: "mcp://paper" }]);
  });
});

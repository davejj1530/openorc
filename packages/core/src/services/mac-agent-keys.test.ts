import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macCodexApiKey, macOpenCodeSignIns } from "./mac-agent-keys.js";

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-mac-keys-"));
  env = { HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "codex"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state") };
});

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  server = null;
  await rm(root, { recursive: true, force: true });
});

async function put(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

describe("this Mac's Codex", () => {
  it("gives its API key when Codex signs in with one", async () => {
    await put(path.join(root, "codex", "auth.json"), { auth_mode: "apikey", OPENAI_API_KEY: "sk-mac-fixture-0123456789" });
    expect(await macCodexApiKey(env)).toBe("sk-mac-fixture-0123456789");
  });

  it("never gives a ChatGPT login, even one that carries a key", async () => {
    await put(path.join(root, "codex", "auth.json"), { OPENAI_API_KEY: "sk-exchanged-0123456789", tokens: { refresh_token: "rt-fixture" } });
    expect(await macCodexApiKey(env)).toBeNull();
    await put(path.join(root, "codex", "auth.json"), { auth_mode: "chatgpt", OPENAI_API_KEY: "sk-exchanged-0123456789" });
    expect(await macCodexApiKey(env)).toBeNull();
  });

  it("finds no key without a login file, as when Codex keeps it in the keychain", async () => {
    expect(await macCodexApiKey(env)).toBeNull();
  });
});

describe("this Mac's OpenCode", () => {
  it("reads OpenCode 1's file: a key for api entries, none for account sign-ins", async () => {
    await put(path.join(root, "data", "opencode", "auth.json"), {
      openrouter: { type: "api", key: "sk-or-fixture-0123456789" },
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: 0 },
      "https://example.test/": { type: "wellknown", key: "k", token: "t" },
    });
    expect(await macOpenCodeSignIns(env)).toEqual([
      { provider: "anthropic", key: null },
      { provider: "openrouter", key: "sk-or-fixture-0123456789" },
    ]);
  });

  it("asks OpenCode 2's service, with its password, for the credential each provider uses", async () => {
    const seen: (string | undefined)[] = [];
    server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      if (request.url !== "/api/credential" || request.headers.authorization !== `Basic ${Buffer.from("opencode:pw-fixture").toString("base64")}`) {
        response.writeHead(401).end();
        return;
      }
      const data = [
        { id: "cred_1", integrationID: "openai", label: "old", active: false, value: { type: "key", key: "sk-old" } },
        { id: "cred_2", integrationID: "openai", label: "now", active: true, value: { type: "key", key: "sk-now-0123456789" } },
        { id: "cred_3", integrationID: "anthropic", label: "pro", active: true, value: { type: "oauth", methodID: "m", refresh: "r", access: "a", expires: 0 } },
      ];
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    // A legacy file beside it is what OpenCode 2 imported once, and is not read.
    await put(path.join(root, "data", "opencode", "auth.json"), { openrouter: { type: "api", key: "sk-or-stale" } });
    await put(path.join(root, "state", "opencode", "service.json"), { id: "svc", version: "2.2.5", url: `http://127.0.0.1:${port}`, pid: 1, password: "pw-fixture" });
    expect(await macOpenCodeSignIns(env)).toEqual([
      { provider: "anthropic", key: null },
      { provider: "openai", key: "sk-now-0123456789" },
    ]);
    await put(path.join(root, "state", "opencode", "service.json"), { id: "svc", version: "2.2.5", url: `http://127.0.0.1:${port}`, pid: 1, password: "wrong" });
    expect(await macOpenCodeSignIns(env)).toEqual([]);
    expect(seen).toHaveLength(2);
  });
});

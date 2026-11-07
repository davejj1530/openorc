import { describe, expect, it } from "vitest";
import type { AgentHome } from "@openorc/agents";
import { brokeredCodexLogin, CodexCloudSignIn } from "./cloud-codex.js";

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: object) => `${part({ alg: "RS256" })}.${part(payload)}.real-signature`;
const claims = { exp: 1_900_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" } };
const chatgpt = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ email: "me@example.com", ...claims }), access_token: jwt(claims), refresh_token: "rt-real", account_id: "acct-1" },
  last_refresh: "2026-11-01T00:00:00.000Z",
});

/** A sandbox's CODEX_HOME as files in memory. */
function sandboxHome(): { home: AgentHome; files: Map<string, string> } {
  const files = new Map<string, string>();
  const home = {
    agent: "codex",
    machine: "sandbox",
    userHome: "/home/vercel-sandbox",
    env: { CODEX_HOME: "/state/codex" },
    binary: "codex",
    read: async (file: string) => (files.has(file) ? Buffer.from(files.get(file)!) : null),
    write: async (file: string, bytes: Buffer) => void files.set(file, bytes.toString("utf8")),
    remove: async (file: string) => void files.delete(file),
  } as unknown as AgentHome;
  return { home, files };
}

describe("Codex's login in a brokered sandbox", () => {
  it("keeps what Codex reads from a ChatGPT login and none of its secrets, and has the firewall send the real access token", () => {
    const brokered = brokeredCodexLogin(chatgpt)!;
    const login = JSON.parse(brokered.auth) as { tokens: Record<string, string>; last_refresh: string };
    for (const secret of ["real-signature", "rt-real"]) expect(brokered.auth).not.toContain(secret);
    expect(login.tokens["account_id"]).toBe("acct-1");
    expect(JSON.parse(Buffer.from(login.tokens["access_token"]!.split(".")[1]!, "base64url").toString("utf8"))).toEqual(claims);
    expect(JSON.parse(Buffer.from(login.tokens["id_token"]!.split(".")[1]!, "base64url").toString("utf8"))).toMatchObject({ email: "me@example.com" });
    expect(Date.now() - Date.parse(login.last_refresh)).toBeLessThan(60_000);
    expect(brokered.header).toEqual({ domain: "chatgpt.com", name: "authorization", value: `Bearer ${jwt(claims)}` });
  });

  it("holds a stand-in for an API key and has the firewall send the key to OpenAI's API", () => {
    const brokered = brokeredCodexLogin(JSON.stringify({ OPENAI_API_KEY: "sk-proj-real" }))!;
    expect(brokered.auth).not.toContain("sk-proj-real");
    expect(brokered.header).toEqual({ domain: "api.openai.com", name: "authorization", value: "Bearer sk-proj-real" });
  });

  it("leaves a login of another shape as it is", () => {
    expect(brokeredCodexLogin(JSON.stringify({ tokens: {} }))).toBeNull();
  });

  it("writes the stand-in into the sandbox, and never adopts it back as the host's login after the turn", async () => {
    const kept: string[] = [];
    const signIn = new CodexCloudSignIn({ has: async () => true, forSandbox: async () => chatgpt, keep: async (auth) => void kept.push(auth) });
    const { home, files } = sandboxHome();
    const turn = await signIn.prepare(async () => home, "vercel", { claudeAccountId: null, model: null }, true);
    expect(turn.headers.map(({ domain }) => domain)).toEqual(["chatgpt.com"]);
    expect(files.get("/state/codex/auth.json")).not.toContain("rt-real");
    await signIn.keep(async () => home);
    expect(kept).toEqual([]);
  });

  it("adopts a login the sandbox refreshed itself when the login was held there", async () => {
    const kept: string[] = [];
    const signIn = new CodexCloudSignIn({ has: async () => true, forSandbox: async () => chatgpt, keep: async (auth) => void kept.push(auth) });
    const { home, files } = sandboxHome();
    const turn = await signIn.prepare(async () => home, "vercel", { claudeAccountId: null, model: null }, false);
    expect(turn.headers).toEqual([]);
    expect(files.get("/state/codex/auth.json")).toBe(chatgpt);
    await signIn.keep(async () => home);
    expect(kept).toEqual([chatgpt]);
  });
});

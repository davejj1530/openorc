import type { AccountStatus } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, type Device, type Seen } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const TOKEN = "sk-ant-oat01-made-on-this-mac-0123456789abcdef";

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  stand.setBilling(ADA, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn(overrides: Partial<HostedDeps> = {}): Promise<{ hosted: Hosted; seen: Seen }> {
  const { deps, seen } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await hosted.account.sendCode(ADA);
  await hosted.account.signIn(ADA, stand.codeFor(ADA)!);
  await vi.waitFor(() => expect(status(hosted).signIns).not.toBeNull());
  return { hosted, seen };
}

function status(hosted: Hosted): Extract<AccountStatus, { state: "signed-in" }> {
  const now = hosted.account.status();
  if (now.state !== "signed-in") throw new Error("signed out");
  return now;
}

/** A token mint the test finishes by hand, as `claude setup-token` would after the browser sign-in. */
function mint() {
  const made = { resolve: (_token: string) => {}, reject: (_error: Error) => {}, cancelled: false, asked: [] as (string | undefined)[] };
  const mintClaudeToken = (id: string | undefined) => {
    made.asked.push(id);
    return {
      token: new Promise<string>((resolve, reject) => Object.assign(made, { resolve, reject })),
      cancel: () => {
        made.cancelled = true;
        made.reject(new Error(""));
      },
    };
  };
  return { made, mintClaudeToken };
}

describe("signing an agent in on OpenOrc Cloud", () => {
  it("makes a Claude token on this Mac as the chosen account and hands it to the server, keeping it nowhere here", async () => {
    const { made, mintClaudeToken } = mint();
    const { hosted, seen } = await signedIn({ mintClaudeToken });
    await hosted.account.connectSignIn({ way: "token", agent: "claude", claudeAccountId: "work" });
    expect(made.asked).toEqual(["work"]);
    expect(status(hosted).signingIn).toEqual({ claude: { state: "waiting", way: "token" } });
    made.resolve(TOKEN);
    await vi.waitFor(() => expect(status(hosted).signIns).toMatchObject([{ agent: "claude", label: "Claude Max", ended: false }]));
    expect(status(hosted).signingIn).toEqual({});
    expect(stand.signInSecrets).toEqual([{ agent: "claude", secret: TOKEN }]);
    const everything = JSON.stringify([device, seen, hosted.account.status()]);
    expect(everything).not.toContain(TOKEN);
  });

  it("says a token the vendor refused in its words, and a cancelled one leaves nothing behind", async () => {
    const { made, mintClaudeToken } = mint();
    const { hosted } = await signedIn({ mintClaudeToken });
    await hosted.account.connectSignIn({ way: "token", agent: "claude" });
    made.resolve("bad-token");
    await vi.waitFor(() => expect(status(hosted).signingIn.claude).toEqual({ state: "failed", error: "Anthropic refused that token. Run `claude setup-token` again and paste the token it prints." }));
    await hosted.account.connectSignIn({ way: "token", agent: "claude" });
    hosted.account.cancelSignIn("claude");
    expect(made.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status(hosted).signingIn).toEqual({});
  });

  it("shows Codex's device code until the person approves it, then the sign-in", async () => {
    const { hosted } = await signedIn();
    await hosted.account.connectSignIn({ way: "code", agent: "codex" });
    expect(status(hosted).signingIn.codex).toMatchObject({
      state: "waiting",
      way: "code",
      userCode: expect.stringMatching(/^[0-9A-F]{4}-[0-9A-F]{4}$/),
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    stand.approveDevice(ADA);
    await vi.waitFor(() => expect(status(hosted).signIns).toMatchObject([{ agent: "codex", label: "ChatGPT Plus" }]), { timeout: 4000 });
    expect(status(hosted).signingIn).toEqual({});
  });

  it("takes an API key for each agent, OpenCode's by provider, refuses one the vendor refuses in its words, and removes them", async () => {
    const { hosted } = await signedIn();
    await expect(hosted.account.connectSignIn({ way: "key", agent: "codex", key: "bad-key" })).rejects.toThrow("OpenAI refused that API key.");
    await hosted.account.connectSignIn({ way: "key", agent: "codex", key: "sk-openai-good" });
    await hosted.account.connectSignIn({ way: "key", agent: "claude", key: "sk-ant-api-good" });
    await hosted.account.connectSignIn({ way: "key", agent: "opencode", provider: "openrouter", key: "sk-or-good" });
    expect(
      status(hosted)
        .signIns?.map((row) => `${row.agent}:${row.provider}`)
        .sort(),
    ).toEqual(["claude:anthropic", "codex:openai", "opencode:openrouter"]);
    await hosted.account.removeSignIn({ agent: "opencode", provider: "openrouter" });
    await hosted.account.removeSignIn({ agent: "codex" });
    expect(status(hosted).signIns?.map((row) => row.agent)).toEqual(["claude"]);
  });

  it("clears an ended sign-in once the person signs that agent in again", async () => {
    stand.setSignIns(ADA, [{ agent: "codex", label: "ChatGPT Plus" }]);
    const { hosted } = await signedIn();
    stand.setSignIns(ADA, [{ agent: "codex", label: "ChatGPT Plus", ended: true }]);
    // The server refused a turn on it as signed out, as a send would learn.
    (hosted.account as unknown as { refused(refusal: string, settings: { agent: string; model: null }): void }).refused("signed_out", { agent: "codex", model: null });
    await vi.waitFor(() => expect(status(hosted).signIns).toMatchObject([{ agent: "codex", ended: true }]));
    await hosted.account.connectSignIn({ way: "key", agent: "codex", key: "sk-openai-good" });
    expect(status(hosted).signIns).toMatchObject([{ agent: "codex", ended: false }]);
  });
});

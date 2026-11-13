import type { AccountStatus, ThreadSummary } from "@openorc/protocol";
import { expect, it } from "vitest";
import { hostedStart, threadSendBlock } from "./hosted-send.js";

const pro: Extract<AccountStatus, { state: "signed-in" }> = {
  state: "signed-in",
  email: "ada@example.com",
  name: "Ada",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: 0 },
  hours: { leftSeconds: 3600, monthly: { grantedSeconds: 3600, leftSeconds: 3600, resetsAt: 0 }, packsLeftSeconds: 0 },
  sandbox: null,
  signingIn: {},
  signIns: [
    { agent: "claude", provider: "anthropic", label: "Claude Max", ended: false },
    { agent: "opencode", provider: "openrouter", label: "API key", ended: false },
  ],
  github: { configured: true, login: "ada", installedOn: ["ada"], repositories: ["ada/notes", "ada/site"] },
  connectingGithub: null,
  projects: [
    { projectId: "mac-notes", repo: "ada/notes", cloud: "added" },
    { projectId: "mac-site", repo: "ada/site", cloud: "addable" },
    { projectId: "mac-api", repo: "acme/api", cloud: "unreadable" },
  ],
  error: null,
};
const hosted = (activity: ThreadSummary["activity"] = "idle") => ({ owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 0 }, activity });
const claude = { agent: "claude", model: "opus" };

it.each([
  { name: "not Pro", account: { ...pro, plan: { pro: false as const }, hours: null }, words: "OpenOrc Cloud needs Pro.", action: "Upgrade" },
  { name: "out of hours", account: { ...pro, hours: { ...pro.hours!, leftSeconds: 0 } }, words: "You're out of cloud hours.", action: "Buy more hours" },
  { name: "a payment not through", account: { ...pro, hours: { leftSeconds: 0, monthly: null, packsLeftSeconds: 0 } }, words: "Your payment hasn't gone through.", action: "Update payment" },
  { name: "no sign-in", account: { ...pro, signIns: [] }, words: "Claude isn't signed in on OpenOrc Cloud.", action: "Sign in" },
  { name: "a sign-in that ended", account: { ...pro, signIns: [{ ...pro.signIns![0]!, ended: true }] }, words: "Claude's sign-in on OpenOrc Cloud ended.", action: "Sign in" },
  { name: "out of reach", account: { ...pro, reach: "offline" as const }, words: "OpenOrc Cloud can't be reached.", action: undefined },
])("blocks a send when $name, with its words and its way on", ({ account, words, action }) => {
  expect(threadSendBlock(hosted(), account, claude)).toMatchObject({ words, action: action ? { label: action } : null });
});

it("lets a send go when nothing stands in the way, and asks nothing of a thread on this Mac", () => {
  expect(threadSendBlock(hosted(), pro, claude)).toBeNull();
  expect(threadSendBlock({ owner: undefined, activity: "idle" }, { ...pro, plan: { pro: false } }, claude)).toBeNull();
});

it("never blocks a message into a running turn by hours or sign-ins, which its starter's cover", () => {
  expect(threadSendBlock(hosted("running"), { ...pro, plan: { pro: false } }, claude)).toBeNull();
  expect(threadSendBlock(hosted("running"), { ...pro, reach: "offline" }, claude)).toMatchObject({ why: "offline" });
});

it("checks OpenCode's sign-in for the provider its model names", () => {
  expect(threadSendBlock(hosted(), pro, { agent: "opencode", model: "openrouter/qwen" })).toBeNull();
  expect(threadSendBlock(hosted(), pro, { agent: "opencode", model: "anthropic/sonnet" })).toMatchObject({ words: "OpenCode isn't signed in on OpenOrc Cloud." });
});

it.each([
  {
    name: "a plan that isn't Pro",
    account: { ...pro, plan: { pro: false as const }, hours: null },
    projectId: "mac-notes",
    words: "OpenOrc Cloud needs Pro.",
    end: { fix: { label: "Upgrade", section: "account" } },
  },
  {
    name: "OpenOrc Cloud out of reach",
    account: { ...pro, reach: "offline" as const },
    projectId: "mac-notes",
    words: "OpenOrc Cloud can't be reached.",
    end: { fix: null, reason: "Can't be reached" },
  },
  {
    name: "an agent's sign-in there that ended",
    account: { ...pro, signIns: [{ ...pro.signIns![0]!, ended: true }] },
    projectId: "mac-notes",
    words: "Claude's sign-in on OpenOrc Cloud ended.",
    end: { fix: { label: "Sign Claude in", section: "cloud" } },
  },
  { name: "a project with no GitHub repository", account: pro, projectId: "mac-local", words: "This project has no GitHub repository.", end: { fix: null, reason: "No GitHub repository" } },
  {
    name: "a repository GitHub doesn't let OpenOrc read",
    account: pro,
    projectId: "mac-api",
    words: "GitHub doesn't let OpenOrc read acme/api yet.",
    end: { fix: { label: "Connect GitHub", section: "cloud", project: "mac-api" } },
  },
  {
    name: "a repository not added yet",
    account: pro,
    projectId: "mac-site",
    words: "ada/site is not on OpenOrc Cloud yet.",
    end: { fix: { label: "Add this project", section: "cloud", project: "mac-site" } },
  },
  {
    name: "an agent not signed in there",
    account: { ...pro, signIns: [] },
    projectId: "mac-notes",
    words: "Claude isn't signed in on OpenOrc Cloud.",
    end: { fix: { label: "Sign Claude in", section: "cloud" } },
  },
  {
    name: "a session the server ended",
    account: { state: "signed-out" as const, codeSentTo: null, ended: true, error: null },
    projectId: "mac-notes",
    words: "Your OpenOrc session ended.",
    end: { fix: { label: "Sign in", section: "account" } },
  },
])("offers OpenOrc Cloud to a new thread blocked by $name, with its words and the way to its fix or the reason its row ends in", ({ account, projectId, words, end }) => {
  expect(hostedStart(account, { projectId, ...claude })).toEqual({ shown: true, blocked: { words, ...end } });
});

it("offers OpenOrc Cloud to a new thread once every part is there, for each agent it runs, and never to someone with no account", () => {
  const signedIn = { ...pro, signIns: [...pro.signIns!, { agent: "codex" as const, provider: "openai", label: "ChatGPT Plus", ended: false }] };
  for (const settings of [claude, { agent: "codex", model: null }, { agent: "opencode", model: "openrouter/qwen" }])
    expect(hostedStart(signedIn, { projectId: "mac-notes", ...settings })).toEqual({ shown: true, blocked: null });
  expect(hostedStart(pro, { projectId: "mac-notes", agent: "cursor", model: null }).blocked).toEqual({
    words: "OpenOrc Cloud runs Claude Code, Codex, and OpenCode.",
    fix: null,
    reason: "Not with Cursor",
  });
  expect(hostedStart({ state: "signed-out", codeSentTo: null, ended: false, error: null }, { projectId: "mac-notes", ...claude })).toEqual({ shown: false, blocked: null });
});

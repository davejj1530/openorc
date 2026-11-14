import type { AccountStatus, RpcParams } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const PRO = { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 } as const;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];
/** The GitHub pages the person's browser was sent to, in order. */
let opened: string[];
/** What the person does on each GitHub page: goes through it, or cancels. */
let onGithub: "through" | "deny" | "wait";

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [
    { id: "mac-api", remote: "git@github.com:acme/api.git" },
    { id: "mac-site", remote: "https://github.com/acme/site" },
    { id: "mac-local", remote: null },
  ];
  opened = [];
  onGithub = "through";
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn() {
  // On GitHub's page the person goes through it, or cancels; the server sends the browser on to the waiting loopback.
  const browser = testBrowser(stand, (url, self) => {
    opened.push(url);
    if (onGithub !== "wait") self.back(stand.github.returnFor(url, { denied: onGithub === "deny" }));
  });
  const { deps } = hostDeps(stand, device, { browser });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.active).toBe(true));
  return hosted;
}

const status = (hosted: Hosted) => hosted.account.status() as Extract<AccountStatus, { state: "signed-in" }>;
const start = (agent: "claude" | "codex" | "opencode", model?: string): RpcParams<"threads.start"> => ({
  hosted: true,
  projectId: "mac-api",
  agent,
  ...(model && { model }),
  mode: "act",
  permissionMode: "trusted",
  prompt: "Add a health check",
});

describe("GitHub on OpenOrc Cloud", () => {
  it("links the person's GitHub, then installs the app, through the browser, and shows what it reaches", async () => {
    stand.github.grant(ADA, ["acme/api"]);
    const hosted = await signedIn();
    expect(status(hosted)).toMatchObject({
      github: { configured: true, login: null, installedOn: [], repositories: [] },
      projects: [
        { projectId: "mac-api", cloud: "unreadable" },
        { projectId: "mac-site", cloud: "unreadable" },
      ],
    });
    await hosted.account.connectGithub();
    await vi.waitFor(() => expect(status(hosted)).toMatchObject({ connectingGithub: null, github: { login: "ada", installedOn: ["ada"], repositories: ["acme/api"] } }));
    expect(opened.map((url) => new URL(url).pathname)).toEqual(["/login/oauth/authorize", "/apps/openorc/installations/new"]);
    expect(status(hosted).projects).toEqual([
      { projectId: "mac-api", repo: "acme/api", cloud: "addable" },
      { projectId: "mac-site", repo: "acme/site", cloud: "unreadable" },
    ]);
  });

  it("says a cancelled GitHub sign-in in words, and Cancel ends a trip with none", async () => {
    const hosted = await signedIn();
    onGithub = "deny";
    await hosted.account.connectGithub();
    await vi.waitFor(() => expect(status(hosted).connectingGithub).toEqual({ state: "failed", error: "GitHub sign-in was cancelled." }));
    onGithub = "wait";
    await hosted.account.connectGithub();
    expect(status(hosted).connectingGithub).toEqual({ state: "waiting" });
    hosted.account.cancelGithub();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status(hosted).connectingGithub).toBeNull();
  });

  it("unlinks the person's GitHub account", async () => {
    const hosted = await signedIn();
    await hosted.account.connectGithub();
    await vi.waitFor(() => expect(status(hosted).github?.login).toBe("ada"));
    await hosted.account.disconnectGithub();
    expect(status(hosted).github?.login).toBeNull();
  });
});

describe("a cloud project and a new thread on it", () => {
  it("adds a Mac project's repository as a cloud project, and refuses one GitHub doesn't let OpenOrc read, in words", async () => {
    stand.github.grant(ADA, ["acme/api"]);
    const hosted = await signedIn();
    await expect(hosted.account.addProject("mac-api")).rejects.toThrow("GitHub doesn't let OpenOrc read acme/api yet.");
    await hosted.account.connectGithub();
    await vi.waitFor(() => expect(status(hosted).projects[0]?.cloud).toBe("addable"));
    await hosted.account.addProject("mac-api");
    expect(status(hosted).projects[0]).toEqual({ projectId: "mac-api", repo: "acme/api", cloud: "added" });
    await expect(hosted.account.addProject("mac-local")).rejects.toThrow("This project has no GitHub repository.");
  });

  it("starts a thread for every agent OpenOrc Cloud runs, ready, with the prompt as its first message, and lists it at once", async () => {
    stand.setBilling(ADA, PRO);
    stand.setSignIns(ADA, [{ agent: "claude" }, { agent: "codex" }, { agent: "opencode", provider: "openrouter" }]);
    stand.addProject(ADA, { name: "api", fullName: "acme/api" });
    const hosted = await signedIn();
    await vi.waitFor(() => expect(status(hosted).projects[0]?.cloud).toBe("added"));
    for (const [agent, model] of [["claude"], ["codex"], ["opencode", "openrouter/qwen3-coder"]] as const) {
      const { thread, run } = await hosted.threads.call("threads.start", start(agent, model));
      expect(hosted.threads.listed("threads.list", { projectId: "mac-api" })?.rows.map((row) => row.id)).toContain(thread.id);
      expect(thread).toMatchObject({ projectId: "mac-api", agent, owner: { brain: "hosted" } });
      expect(run?.id).toBe(`hosted:${thread.id}`);
    }
    expect(stand.started.map(({ space, body }) => [space, body["ready"], (body["first"] as { text: string }).text, (body["settings"] as { agent: string }).agent])).toEqual([
      ["personal-ada@example.com", true, "Add a health check", "claude"],
      ["personal-ada@example.com", true, "Add a health check", "codex"],
      ["personal-ada@example.com", true, "Add a health check", "opencode"],
    ]);
  });

  it("makes no thread when the server refuses its first message, and says why in the card's words", async () => {
    stand.addProject(ADA, { name: "api", fullName: "acme/api" });
    const hosted = await signedIn();
    await vi.waitFor(() => expect(status(hosted).projects[0]?.cloud).toBe("added"));
    await expect(hosted.threads.call("threads.start", start("claude"))).rejects.toThrow("OpenOrc Cloud needs Pro.");
    expect(hosted.threads.listed("threads.list", {})?.rows).toEqual([]);
  });

  it("refuses a start for a project with no cloud project, and one for an agent OpenOrc Cloud doesn't run, in words", async () => {
    const hosted = await signedIn();
    await expect(hosted.threads.call("threads.start", start("claude"))).rejects.toThrow("Add this project to OpenOrc Cloud in Settings first.");
    await expect(hosted.threads.call("threads.start", { ...start("claude"), agent: "pi" })).rejects.toThrow("Pi doesn't run on OpenOrc Cloud.");
    expect(stand.started).toEqual([]);
  });
});

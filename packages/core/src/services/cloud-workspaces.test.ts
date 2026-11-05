import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokeringUnavailable, LocalSandboxProvider, type BrokeredHeader, type SandboxNeeds, type SandboxProvider } from "@openorc/cloud";
import { cloudWorkspaces, Db, projects, threads } from "@openorc/db";
import { git } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { cloudAgents, SANDBOX_OWN } from "./cloud-agents.js";
import { CodexCloudSignIn } from "./cloud-codex.js";
import { OpenCodeCloudKeys, OpenCodeCloudSignIn } from "./cloud-opencode.js";
import { CloudWorkspaceService, cloudSandboxProviders, LOCAL_LAUNCH_REFUSED } from "./cloud-workspaces.js";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import type { Logger } from "../transport.js";

const quiet = { info() {}, warn() {}, error() {} };

let directory: string;
let root: string;
let db: Db;
let project: Project;
let sandboxes: LocalSandboxProvider;
let service: WorkspaceService;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-workspace-")));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Fixture"]);
  await git(root, ["remote", "add", "origin", "https://github.com/example/fixture.git"]);
  db = Db.memory();
  project = projects.insert(db, {
    name: "Fixture",
    rootPath: root,
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: 'printf "%s %s\\n" "$OPENORC_CLOUD" "$OPENORC_ROOT_PATH" >> setup-runs.txt', worktreeInclude: [] },
  });
  sandboxes = new LocalSandboxProvider(path.join(directory, "sandboxes"));
  const cloud = new CloudWorkspaceService(db, { providers: [sandboxes] }, quiet);
  service = new WorkspaceService(db, { dataDir: path.join(directory, "data"), cloud }, quiet, new WorkspaceWriters());
});

afterEach(async () => {
  await service.shutdown();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function cloudThread(): Thread {
  return db.transaction(() => {
    const thread = threads.insert(db, { projectId: project.id, title: "Cloud work", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    service.admitCloud(thread.id, "local");
    return thread;
  });
}

const sandboxRepo = (thread: Thread) => path.join(directory, "sandboxes", `openorc-${thread.id}`, "repo");

describe("cloud workspace preparation", () => {
  it("makes the Mac's worktree, gives the sandbox its branch and runs the setup script only in the sandbox", async () => {
    const prepared = await service.prepareThread(cloudThread(), project, "HEAD");
    const repo = sandboxRepo(prepared);
    expect(prepared.worktreePath).toBeTruthy();
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.worktreePath!, encoding: "utf8" }));
    expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe(prepared.branch);
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim()).toBe("https://github.com/example/fixture.git");
    expect(readFileSync(path.join(repo, "setup-runs.txt"), "utf8")).toBe(`1 ${repo}\n`);
    expect(existsSync(path.join(prepared.worktreePath!, "setup-runs.txt"))).toBe(false);
    const record = cloudWorkspaces.get(db, prepared.id)!;
    expect(record.state).toBe("ready");
    expect(record.mirror).toEqual({
      snapshot: null,
      tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
      known: [expect.stringMatching(/^[0-9a-f]{40}$/)],
    });
  });

  it("leaves a ready workspace alone when the conversation continues", async () => {
    const prepared = await service.prepareThread(cloudThread(), project, "HEAD");
    const before = cloudWorkspaces.get(db, prepared.id);
    await service.prepareThread(threads.get(db, prepared.id)!, project);
    expect(cloudWorkspaces.get(db, prepared.id)).toEqual(before);
    expect(
      readFileSync(path.join(sandboxRepo(prepared), "setup-runs.txt"), "utf8")
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(1);
  });

  it("records a failed setup and tries again on the next preparation", async () => {
    const failing = { ...project, settings: { ...project.settings, setupScript: "echo 'npm missing' >&2; exit 4" } };
    const thread = cloudThread();
    await expect(service.prepareThread(thread, failing, "HEAD")).rejects.toThrow(/setup script failed in the cloud workspace \(exit 4\)\.\nnpm missing/);
    expect(cloudWorkspaces.get(db, thread.id)).toMatchObject({ state: "failed", error: expect.stringMatching(/npm missing/), mirror: null });

    await service.prepareThread(threads.get(db, thread.id)!, { ...project, settings: { ...project.settings, setupScript: "touch fixed.txt" } });
    expect(cloudWorkspaces.get(db, thread.id)).toMatchObject({ state: "ready", error: null });
    expect(existsSync(path.join(sandboxRepo(thread), "fixed.txt"))).toBe(true);
  });

  it("runs a project without a cloud workspace on the Mac as before", async () => {
    const local = threads.insert(db, { projectId: project.id, title: "Local work", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const prepared = await service.prepareThread(local, project, "HEAD");
    expect(readFileSync(path.join(prepared.worktreePath!, "setup-runs.txt"), "utf8")).toBe(` ${root}\n`);
    expect(existsSync(path.join(directory, "sandboxes", `openorc-${prepared.id}`))).toBe(false);
    expect(cloudWorkspaces.get(db, prepared.id)).toBeNull();
  });
});

describe("a cloud workspace's last pull", () => {
  it("fails when the conversation leaves its sandbox and its session does not come too, and only warns after a turn", async () => {
    const sessions = { send: async () => undefined, keep: async () => Promise.reject(new Error("The session did not come.")) };
    const cloud = new CloudWorkspaceService(db, { providers: [sandboxes], sessions: sessions as never }, quiet);
    const workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "data-leaving"), cloud }, quiet, new WorkspaceWriters());
    try {
      const thread = db.transaction(() => {
        const created = threads.insert(db, { projectId: project.id, title: "Leaving", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
        workspaces.admitCloud(created.id, "local");
        return created;
      });
      const prepared = await workspaces.prepareThread(thread, project, "HEAD");
      await expect(cloud.sync(prepared, { turnEnded: true })).resolves.toEqual(expect.any(Boolean));
      await expect(cloud.sync(prepared, { turnEnded: true, leaving: true })).rejects.toThrow("The session did not come.");
    } finally {
      await workspaces.shutdown();
    }
  });
});

describe("what a sandbox got of its conversation's session", () => {
  it("is handed to each turn's keep and replaced by what it returns, and recorded again when a new sandbox is seeded", async () => {
    const base = (n: number) => ({ sessionId: "s-1", host: `h${n}`, sandbox: `b${n}` });
    const given: unknown[] = [];
    const sessions = { send: async () => base(0), keep: async (_t: unknown, _l: unknown, _p: unknown, previous: unknown) => (given.push(previous), base(given.length)) };
    // The agent's CLI is looked for before its session goes in: a stand-in here, never the person's own.
    const bin = path.join(directory, "bin-base");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\necho 2.1.317\n", { mode: 0o755 });
    const local = new LocalSandboxProvider(path.join(directory, "sandboxes-base"), () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` }));
    const cloud = new CloudWorkspaceService(db, { providers: [local], sessions: sessions as never }, quiet);
    const workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "data-base"), cloud }, quiet, new WorkspaceWriters());
    try {
      const thread = db.transaction(() => {
        const created = threads.insert(db, { projectId: project.id, title: "Based", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
        workspaces.admitCloud(created.id, "local");
        return created;
      });
      const prepared = await workspaces.prepareThread(thread, project, "HEAD");
      await cloud.sync(prepared, { turnEnded: true });
      await cloud.sync(prepared, { turnEnded: true });
      expect(given).toEqual([null, base(1)]);
      expect(cloud.get(thread.id)?.sessionBase).toEqual(base(2));
      // A removed sandbox forgets it; the next one is seeded with the session and records what it got.
      cloudWorkspaces.removed(db, thread.id);
      expect(cloud.get(thread.id)?.sessionBase).toBeNull();
      await cloud.prepare(prepared, project);
      await cloud.sync(prepared, { turnEnded: true });
      expect(given.at(-1)).toEqual(base(0));
    } finally {
      await workspaces.shutdown();
    }
  });

  it("comes with a standby that took over, so its first keep compares against what the standby last sent", () => {
    const cloud = new CloudWorkspaceService(db, { providers: [sandboxes] }, quiet);
    const thread = threads.insert(db, { projectId: project.id, title: "Adopted", agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const sent = { sessionId: "s-2", host: "h", sandbox: "b" };
    cloud.adopt({ threadId: thread.id, provider: "local", sandbox: `openorc-${thread.id}` }, { snapshot: null, tree: "t".repeat(40), head: null, known: [] }, sent);
    expect(cloud.get(thread.id)?.sessionBase).toEqual(sent);
  });
});

describe("an agent in a sandbox for a turn", () => {
  it("is brought to this host's version on a real sandbox, with its own folders, and left alone on one simulated here", async () => {
    const runs: string[][] = [];
    const sandbox = {
      exec: async (cmd: string, args: string[]) => {
        runs.push([cmd, ...args]);
        return cmd === "sh" ? { code: 0, stdout: Buffer.from("opencode v2.0.10\n"), stderr: "" } : { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      },
    };
    const location = { install: { sandbox, state: "/sandbox/.openorc" }, repo: "/sandbox/repo" } as never;
    const cloud = new CloudWorkspaceService(db, { providers: [sandboxes], versions: async (agent) => (agent === "opencode" ? "2.0.11" : null) }, quiet);
    expect(await cloud.turnEnv({ agent: "opencode", model: "opencode/free" }, location, "vercel")).toEqual({ XDG_DATA_HOME: "/sandbox/.openorc/opencode" });
    expect(runs.filter(([cmd]) => cmd === "npm")).toEqual([["npm", "install", "-g", "@opencode/cli@2.0.11"]]);
    runs.length = 0;
    await cloud.turnEnv({ agent: "opencode", model: "opencode/free" }, location, "local");
    expect(runs.filter(([cmd]) => cmd === "npm")).toEqual([]);
  });

  describe("with its sign-in kept outside the sandbox", () => {
    const keys = { load: async () => JSON.stringify({ openrouter: { key: "sk-or-real", createdAt: 1 } }), save: async () => undefined };
    const agents = cloudAgents({ claude: SANDBOX_OWN, codex: new CodexCloudSignIn(undefined), opencode: new OpenCodeCloudSignIn(new OpenCodeCloudKeys(keys)) });
    const brokering = (refuse = false) => {
      const applied: BrokeredHeader[][] = [];
      const sandbox = {
        exec: async (cmd: string) => ({ code: 0, stdout: Buffer.from(cmd === "sh" ? "opencode v2.0.10\n" : ""), stderr: "" }),
        broker: async (headers: BrokeredHeader[]) => {
          if (refuse && headers.length) throw new BrokeringUnavailable("This Vercel plan cannot add sign-ins outside the sandbox.");
          applied.push(headers);
        },
      };
      return { applied, location: { install: { sandbox, state: "/sandbox/.openorc" }, repo: "/sandbox/repo" } as never };
    };
    const paid = { agent: "opencode", model: "openrouter/acme/fast" };

    it("has the firewall add the key, once while it is unchanged, and clears it for a turn that needs none", async () => {
      const { applied, location } = brokering();
      const cloud = new CloudWorkspaceService(db, { providers: [sandboxes], agents }, quiet);
      expect(JSON.stringify(await cloud.turnEnv(paid, location, "vercel"))).not.toContain("sk-or-real");
      await cloud.turnEnv(paid, location, "vercel");
      expect(applied).toEqual([[{ domain: "openrouter.ai", name: "authorization", value: "Bearer sk-or-real" }]]);
      await cloud.turnEnv({ agent: "opencode", model: "opencode/free" }, location, "vercel");
      expect(applied.at(-1)).toEqual([]);
    });

    it("puts the key in the sandbox when the plan refuses, clears what an earlier session had the firewall add, and stops asking", async () => {
      const warnings: string[] = [];
      const { applied, location } = brokering(true);
      const cloud = new CloudWorkspaceService(db, { providers: [sandboxes], agents }, { ...quiet, warn: (message: string) => void warnings.push(message) });
      expect(JSON.stringify(await cloud.turnEnv(paid, location, "vercel"))).toContain("sk-or-real");
      expect(JSON.stringify(await cloud.turnEnv(paid, location, "vercel"))).toContain("sk-or-real");
      expect(warnings).toEqual(["cloud sign-ins stay in their sandboxes: This Vercel plan cannot add sign-ins outside the sandbox."]);
      expect(applied).toEqual([[]]);
    });
  });
});

describe("Docker in a cloud workspace", () => {
  /**
   * Sandboxes on this Mac that record what each was opened for and, when `docker`, stand in for a VM's Docker: its
   * daemon runs once started, leaves a mark in the sandbox for the setup script, and is gone when the VM stops.
   */
  function dockerSandboxes(docker: boolean) {
    // The agent's CLI is looked for before a turn: a stand-in here, never the person's own.
    const bin = path.join(directory, "bin-docker");
    const local = new LocalSandboxProvider(path.join(directory, "sandboxes-docker"), () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` }));
    const opened: SandboxNeeds[] = [];
    const daemon = { starts: 0, running: false };
    const provider: SandboxProvider = {
      id: "local",
      open: async (name, needs = {}) => {
        opened.push(needs);
        const sandbox = await local.open(name);
        if (!docker) return sandbox;
        const stop = sandbox.stop.bind(sandbox);
        const mark = path.join(sandbox.root, "docker-up");
        return Object.assign(sandbox, {
          startDocker: async () => {
            daemon.starts++;
            daemon.running = true;
            await writeFile(mark, "");
          },
          stop: async () => {
            daemon.running = false;
            await rm(mark, { force: true });
            await stop();
          },
        });
      },
      remove: (name) => local.remove(name),
      list: () => local.list(),
      close: () => local.close(),
    };
    return { provider, opened, daemon, bin };
  }

  async function prepared(sandboxes: SandboxProvider, logger: Logger = quiet) {
    const cloud = new CloudWorkspaceService(db, { providers: [sandboxes] }, logger);
    const workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "data-docker"), cloud }, logger, new WorkspaceWriters());
    const thread = db.transaction(() => {
      const created = threads.insert(db, { projectId: project.id, title: "Containers", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
      workspaces.admitCloud(created.id, "local");
      return created;
    });
    const setup = '[ -f "$OPENORC_ROOT_PATH/../docker-up" ] && echo up > docker-seen.txt || echo down > docker-seen.txt';
    const ready = await workspaces.prepareThread(thread, { ...project, settings: { ...project.settings, setupScript: setup } }, "HEAD");
    const location = await cloud.location(cloud.get(ready.id)!, ready.worktreePath!);
    return { cloud, workspaces, location, seen: () => readFileSync(path.join(location.repo, "docker-seen.txt"), "utf8").trim() };
  }

  async function composeProject(): Promise<void> {
    await writeFile(path.join(root, "compose.yaml"), "services:\n  db:\n    image: postgres:17\n");
    await git(root, ["add", "compose.yaml"]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Compose"]);
  }

  it("opens a new conversation's sandbox for the Docker its project uses and starts it before the setup script, and again before each turn after the VM stopped", async () => {
    await composeProject();
    const { provider, opened, daemon, bin } = dockerSandboxes(true);
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\necho 2.1.317\n", { mode: 0o755 });
    const { cloud, workspaces, location, seen } = await prepared(provider);
    try {
      // The worktree was still being made when the sandbox opened, so the need came from the commit it starts at.
      expect(opened).toEqual([{ docker: true }]);
      expect(seen()).toBe("up");
      await location.install.sandbox.stop();
      expect(daemon.running).toBe(false);
      await cloud.turnEnv({ agent: "claude" }, location, "local");
      expect(daemon.running).toBe(true);
      await location.install.sandbox.stop();
      await cloud.turnEnv({ agent: "claude" }, location, "local");
      expect(daemon).toEqual({ starts: 3, running: true });
    } finally {
      await workspaces.shutdown();
    }
  });

  it("opens a sandbox without it for a project that does not use Docker, and never starts it", async () => {
    const { provider, opened, daemon } = dockerSandboxes(true);
    const { workspaces, seen } = await prepared(provider);
    try {
      expect(opened).toEqual([{ docker: false }]);
      expect(seen()).toBe("down");
      expect(daemon.starts).toBe(0);
    } finally {
      await workspaces.shutdown();
    }
  });

  it("goes on with one line in the log when the sandbox cannot run Docker, as an Agent37 instance made before its project used it", async () => {
    await composeProject();
    const lines: string[] = [];
    const { provider } = dockerSandboxes(false);
    const { workspaces, seen } = await prepared(provider, { ...quiet, info: (line: string) => void lines.push(line) });
    try {
      expect(seen()).toBe("down");
      expect(lines.filter((line) => line.includes("Docker"))).toEqual([expect.stringMatching(/^cloud workspace openorc-\S+ has no Docker of its own, though its project uses Docker$/)]);
    } finally {
      await workspaces.shutdown();
    }
  });
});

describe("where cloud conversations run", () => {
  it("puts new conversations on Vercel once it is connected, and on this Mac until then", async () => {
    let access: { token: string; teamId: string; projectId: string } | null = null;
    const cloud = new CloudWorkspaceService(db, cloudSandboxProviders({ dataDir: directory, env: () => process.env, credentials: async () => access }), quiet);
    expect(await cloud.place({ agent: "claude" }, project)).toBe("local");
    access = { token: "tok", teamId: "team", projectId: "proj" };
    expect(await cloud.place({ agent: "claude" }, project)).toBe("vercel");
    await expect(cloud.place({ agent: "codex" }, project)).rejects.toThrow("Codex has no sign-in for the cloud.");
    expect(await cloud.place({ agent: "opencode", model: "opencode/free-model" }, project)).toBe("vercel");
    await expect(cloud.place({ agent: "opencode", model: "openrouter/acme/fast" }, project)).rejects.toThrow("OpenCode has no key for OpenRouter in the cloud. Add one in Settings > Cloud.");
  });

  it("puts new conversations on the service chosen, and keeps each workspace on the service it was made with", async () => {
    let service: "vercel" | "agent37" | null = "agent37";
    const options = cloudSandboxProviders({
      dataDir: directory,
      env: () => process.env,
      credentials: async () => ({ token: "tok", teamId: "team", projectId: "proj" }),
      agent37: async () => ({ key: "sk_live_x", cpu: 2, memory: 4 }),
      service: async () => service,
    });
    const cloud = new CloudWorkspaceService(db, options, quiet);
    expect(await cloud.place({ agent: "claude" }, project)).toBe("agent37");
    service = "vercel";
    expect(await cloud.place({ agent: "claude" }, project)).toBe("vercel");
    service = null;
    expect(await cloud.place({ agent: "claude" }, project)).toBe("local");
    expect(options.providers.map((provider) => provider.id)).toEqual(["local", "vercel", "agent37"]);
  });

  it("lets a provider passed in take new conversations, whatever is connected", async () => {
    const cloud = new CloudWorkspaceService(
      db,
      cloudSandboxProviders({ dataDir: directory, env: () => process.env, credentials: async () => ({ token: "t", teamId: "t", projectId: "p" }), override: sandboxes }),
      quiet,
    );
    expect(await cloud.place({ agent: "claude" }, project)).toBe("local");
  });

  it("opens a workspace on the service it was made with", async () => {
    const cloud = new CloudWorkspaceService(db, cloudSandboxProviders({ dataDir: directory, env: () => process.env }), quiet);
    const thread = threads.insert(db, { projectId: project.id, title: "On Vercel", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const record = cloud.admit(thread.id, "vercel");
    await expect(cloud.location(record, path.join(directory, "mirror"))).rejects.toThrow("Connect Vercel in Settings to run in the cloud.");
  });
});

describe("a cloud-only host", () => {
  it("has no sandboxes in folders: without a connection, a new conversation goes to Vercel, which asks for one", async () => {
    const options = cloudSandboxProviders({ dataDir: directory, env: () => process.env, credentials: async () => null, cloudOnly: true });
    expect(options.providers.map((provider) => provider.id)).toEqual(["vercel", "agent37"]);
    const cloud = new CloudWorkspaceService(db, { ...options, cloudOnly: true }, quiet);
    const thread = threads.insert(db, { projectId: project.id, title: "Cloud only", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const record = cloud.admit(thread.id, await cloud.place({ agent: "claude" }, project));
    expect(record.provider).toBe("vercel");
    await expect(cloud.location(record, path.join(directory, "mirror"))).rejects.toThrow("Connect Vercel in Settings to run in the cloud.");
  });

  it("refuses every launch that would run on this machine, with or without a conversation", async () => {
    const run = { agent: "claude" };
    const local = threads.insert(db, { projectId: project.id, title: "Local", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
    const only = new CloudWorkspaceService(db, { providers: [sandboxes], cloudOnly: true }, quiet);
    await expect(only.host(null, "http://127.0.0.1:1", run)).rejects.toThrow(LOCAL_LAUNCH_REFUSED);
    await expect(only.host(local, "http://127.0.0.1:1", run)).rejects.toThrow(LOCAL_LAUNCH_REFUSED);
    const mac = new CloudWorkspaceService(db, { providers: [sandboxes] }, quiet);
    expect(await mac.host(null, "http://127.0.0.1:1", run)).toBeNull();
    expect(await mac.host(local, "http://127.0.0.1:1", run)).toBeNull();
  });
});

describe("a cloud workspace's busy signal", () => {
  it("reads busy while a new conversation's sandbox is built and held, and idle once it has stopped", async () => {
    const quick = new LocalSandboxProvider(path.join(directory, "quick"), () => process.env, 400);
    const cloud = new CloudWorkspaceService(db, { providers: [quick] }, quiet);
    const workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "quick-data"), cloud }, quiet, new WorkspaceWriters());
    const thread = db.transaction(() => {
      const row = threads.insert(db, { projectId: project.id, title: "Busy", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
      workspaces.admitCloud(row.id, "local");
      return row;
    });
    expect(cloud.busy).toBe(false);
    const preparing = workspaces.prepareThread(thread, project, "HEAD");
    await vi.waitFor(() => expect(cloud.busy).toBe(true));
    await preparing;
    await vi.waitFor(() => expect(cloud.busy).toBe(false), { timeout: 5_000 });
    await workspaces.shutdown();
    await cloud.close();
  });
});

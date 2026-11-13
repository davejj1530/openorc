import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteProcess } from "./remote-process.js";
import { installRunner, RunnerClient, type RunnerFile, type RunnerInstall } from "./runner-client.js";
import { BrokeringUnavailable, SANDBOX_PREFIX, type Sandbox, type SandboxProvider } from "./sandbox.js";
import { pullWorkspace, seedWorkspace } from "./sync.js";

const run = promisify(execFile);

export const CHECK_STEPS = ["sandbox", "tools", "runner", "relay", "signins", "sync", "remove"] as const;
export type CheckStep = (typeof CHECK_STEPS)[number];

export interface CheckProgress {
  step: CheckStep;
  /** `skipped`: the step does not apply here, which `detail` says why. */
  state: "running" | "done" | "skipped" | "failed";
  /** How long the step took, once it ended. */
  ms?: number;
  /** What the step found, such as the tool versions. */
  detail?: string;
  error?: string;
}

/** A step that does not apply where the check runs, and why. */
class Skipped {
  constructor(readonly why: string) {}
}

/** The oldest Node that runs TypeScript without flags, which the runner needs. */
const NODE_MIN = [22, 18] as const;
/** Making a sandbox can include installing Claude Code in it. */
const SANDBOX_TIMEOUT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 2 * 60_000;
/** Getting the tools ready can include installing Claude Code, as a thread's first turn does. */
const TOOLS_TIMEOUT_MS = 5 * 60_000;
const RELAY_ANSWER = "openorc-check";
/**
 * An API agents call, which answers a request without a key differently from one with a wrong key: the check's
 * request carries a key only if the firewall added it.
 */
const SIGN_IN_PROBE = { domain: "api.anthropic.com", url: "https://api.anthropic.com/v1/models", header: "x-api-key" };
/** The firewall's new rules can take a moment to reach the VM. */
const BROKER_ATTEMPTS = 5;

function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s.`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The output a process printed, once it exits. */
function finished(proc: RemoteProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return new Promise((resolve) => proc.once("close", (code: number | null) => resolve({ code, stdout, stderr })));
}

async function version(sandbox: Sandbox, command: string): Promise<string | null> {
  const result = await sandbox.exec("sh", ["-c", `command -v ${command} >/dev/null && ${command} --version`]);
  return result.code === 0 ? result.stdout.toString("utf8").trim().split("\n")[0]!.trim() : null;
}

async function tools(sandbox: Sandbox, node: string, agent: ((sandbox: Sandbox) => Promise<void>) | undefined): Promise<string> {
  const [nodeVersion, gitVersion] = await Promise.all([version(sandbox, node), version(sandbox, "git")]);
  if (!nodeVersion) throw new Error("Node is not installed in the sandbox.");
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, "").split(".").map(Number);
  if (major < NODE_MIN[0] || (major === NODE_MIN[0] && minor < NODE_MIN[1])) throw new Error(`Node ${nodeVersion} is too old for OpenOrc's runner; it needs ${NODE_MIN.join(".")} or later.`);
  if (!gitVersion) throw new Error("Git is not installed in the sandbox.");
  await agent?.(sandbox);
  const claudeVersion = await version(sandbox, "claude");
  if (!claudeVersion) throw new Error("Claude Code is not installed in the sandbox.");
  const number = (text: string) => /\d+(?:\.\d+)+/.exec(text)?.[0] ?? text;
  return `Node ${number(nodeVersion)} · Git ${number(gitVersion)} · Claude Code ${number(claudeVersion)}`;
}

/** A process in the sandbox answers input through the runner. */
async function roundTrip(client: RunnerClient, sandbox: Sandbox, node: string): Promise<void> {
  const proc = client.spawn(`check-${randomUUID()}`, {
    cmd: node,
    args: ["-e", `process.stdin.on("data", (d) => process.stdout.write("pong " + d)); process.stdin.on("end", () => process.exit(0));`],
    cwd: sandbox.root,
    env: {},
  });
  const done = finished(proc);
  proc.stdin.end("ping\n");
  const result = await done;
  if (result.code !== 0 || result.stdout !== "pong ping\n") throw new Error(`The runner's process answered ${JSON.stringify(result.stdout)} (exit ${result.code}). ${result.stderr.trim()}`.trim());
}

/** A request from the sandbox's loopback reaches a server on this Mac, as the agent's MCP calls do. */
async function relay(client: RunnerClient, sandbox: Sandbox, node: string): Promise<void> {
  const server = http.createServer((_request, response) => response.end(RELAY_ANSWER));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = await client.relay(`check-${randomUUID()}`, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const proc = client.spawn(`check-${randomUUID()}`, {
      cmd: node,
      args: ["-e", `fetch("http://127.0.0.1:${port}/check").then((r) => r.text()).then((t) => process.stdout.write(t))`],
      cwd: sandbox.root,
      env: {},
    });
    const result = await finished(proc);
    if (result.stdout !== RELAY_ANSWER) throw new Error(`The sandbox could not reach this Mac. ${result.stderr.trim()}`.trim());
  } finally {
    server.close();
  }
}

/** What the probe API says to a request from the sandbox, through the runner as an agent's requests go. */
async function probeAnswer(client: RunnerClient, sandbox: Sandbox, node: string): Promise<string> {
  const proc = client.spawn(`check-${randomUUID()}`, {
    cmd: node,
    args: [
      "-e",
      `fetch(${JSON.stringify(SIGN_IN_PROBE.url)}).then((r) => r.json()).then((j) => process.stdout.write(String(j?.error?.message ?? "")), (e) => { process.stderr.write(String(e?.cause?.code ?? e?.cause?.message ?? e)); process.exit(1); })`,
    ],
    cwd: sandbox.root,
    env: {},
  });
  const result = await finished(proc);
  if (result.code !== 0) throw new Error(`The sandbox could not reach ${SIGN_IN_PROBE.domain}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The firewall adds a sign-in to a request on its way out, so agents can work with no sign-in in the sandbox: it adds a
 * made-up key, which the API reads as a key, and the sandbox's Node trusts the certificate the firewall answers with.
 * Nothing secret is added, and the rule is cleared after.
 */
async function signIns(client: RunnerClient, sandbox: Sandbox, node: string, simulated: boolean): Promise<string | Skipped | void> {
  if (!sandbox.broker) return new Skipped(simulated ? "Sandboxes on this Mac use this Mac's sign-ins." : "This service keeps each agent's sign-in in its sandbox.");
  const without = await probeAnswer(client, sandbox, node);
  try {
    await sandbox.broker([{ domain: SIGN_IN_PROBE.domain, name: SIGN_IN_PROBE.header, value: `openorc-check-${randomUUID()}` }]);
  } catch (error) {
    throw error instanceof BrokeringUnavailable ? new Error(`${error.message} Each sandbox holds its agent's sign-in.`) : error;
  }
  try {
    for (let attempt = 1; attempt <= BROKER_ATTEMPTS; attempt++) {
      const answer = await probeAnswer(client, sandbox, node).catch((error: unknown) => {
        throw new Error(`The sandbox does not trust its firewall's certificate, so agents could not sign in. ${error instanceof Error ? error.message : String(error)}`);
      });
      if (answer !== without) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("The sandbox's firewall did not add a sign-in to a request, so agents could not sign in.");
  } finally {
    await sandbox.broker([]);
  }
}

/** A small repository goes to the sandbox, a file is made there, and it comes back. */
async function sync(install: RunnerInstall): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-check-"));
  try {
    const mirror = path.join(dir, "repo");
    await mkdir(mirror);
    const identity = { ...process.env, GIT_AUTHOR_NAME: "OpenOrc", GIT_AUTHOR_EMAIL: "check@openorc.app", GIT_COMMITTER_NAME: "OpenOrc", GIT_COMMITTER_EMAIL: "check@openorc.app" };
    await run("git", ["init", "-q", "-b", "main"], { cwd: mirror });
    await writeFile(path.join(mirror, "README.md"), "Checking a cloud workspace\n");
    await run("git", ["add", "-A"], { cwd: mirror });
    await run("git", ["commit", "-q", "-m", "Check"], { cwd: mirror, env: identity });
    const location = { install, repo: path.posix.join(install.sandbox.root, "repo"), mirror, refPrefix: "refs/openorc/check/" };
    const state = await seedWorkspace(location, "main");
    const made = await install.sandbox.exec("sh", ["-c", "echo made in the sandbox > checked.txt"], { cwd: location.repo });
    if (made.code !== 0) throw new Error(`The sandbox could not change its copy: ${made.stderr.trim()}`);
    const pulled = await pullWorkspace(location, state);
    const back = await readFile(path.join(mirror, "checked.txt"), "utf8").catch(() => null);
    if (!pulled.changed || back !== "made in the sandbox\n") throw new Error("The sandbox's change did not reach this Mac.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Tries everything a cloud thread needs from `provider` in a throwaway sandbox: making it, the tools in it, OpenOrc's
 * runner and relay, sign-ins kept outside it, and sync both ways. The sandbox is deleted at the end, whatever failed.
 * True when every step passed.
 */
export async function checkSandbox(
  provider: SandboxProvider,
  options: {
    files: RunnerFile[];
    node?: string;
    /** Puts Claude Code in the sandbox the way a thread's first turn does, where the service's image has none. */
    agent?: (sandbox: Sandbox) => Promise<void>;
    report: (progress: CheckProgress) => void;
  },
): Promise<boolean> {
  const node = options.node ?? "node";
  const name = `${SANDBOX_PREFIX}check-${randomUUID().slice(0, 8)}`;
  let sandbox: Sandbox | null = null;
  let client: RunnerClient | null = null;
  let install: RunnerInstall | null = null;
  const step = async (id: CheckStep, work: () => Promise<string | Skipped | void>, timeout = STEP_TIMEOUT_MS): Promise<boolean> => {
    const started = Date.now();
    options.report({ step: id, state: "running" });
    try {
      // The sandbox stays up for as long as the step may take, as a thread's sandbox does while its agent works.
      if (sandbox && id !== "remove") await (sandbox as Sandbox).keepAwake(timeout);
      const found = await within(timeout, work(), "This step");
      if (found instanceof Skipped) options.report({ step: id, state: "skipped", detail: found.why });
      else options.report({ step: id, state: "done", ms: Date.now() - started, ...(found ? { detail: found } : {}) });
      return true;
    } catch (error) {
      options.report({ step: id, state: "failed", ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  const passed =
    (await step(
      "sandbox",
      async () => {
        sandbox = await provider.open(name);
      },
      SANDBOX_TIMEOUT_MS,
    )) &&
    (await step("tools", () => tools(sandbox!, node, options.agent), TOOLS_TIMEOUT_MS)) &&
    (await step("runner", async () => {
      install = await installRunner(sandbox!, options.files, node);
      client = await RunnerClient.open(install);
      await roundTrip(client, sandbox!, node);
    })) &&
    (await step("relay", () => relay(client!, sandbox!, node))) &&
    (await step("signins", () => signIns(client!, sandbox!, node, provider.id === "local"))) &&
    (await step("sync", () => sync(install!)));
  (client as RunnerClient | null)?.close();
  const removed = await step("remove", () => provider.remove(name));
  return passed && removed;
}

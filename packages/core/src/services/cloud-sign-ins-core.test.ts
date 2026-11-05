import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { inheritedProbe } from "./shell-environment.js";

const MINTED = "sk-ant-oat01-Minted_for_the_cloud-0123456789";
const MAC_CODEX_KEY = "sk-mac-codex-fixture-0123456789";
const MAC_OPENROUTER_KEY = "sk-or-mac-fixture-0123456789";

/** `claude setup-token` once the browser approved it: the token on its screen. */
const FAKE_CLAUDE = `#!/usr/bin/env node
if (!process.argv.includes("setup-token")) process.exit(64);
process.stdout.write("Your OAuth token (valid for 1 year):\\n${MINTED}\\n");
setInterval(() => {}, 1000);
`;

function memoryStore() {
  const saved: string[] = [];
  return { load: async () => saved.at(-1) ?? null, save: async (value: string) => void saved.push(value), saved };
}

let root: string;
let core: OpenOrc;
let claudeTokens: ReturnType<typeof memoryStore>;

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const reply = await core.handle({ type: "rpc", id: 1, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result as RpcResults[M];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-sign-ins-core-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  await mkdir(path.join(root, "codex"));
  await writeFile(path.join(root, "codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: MAC_CODEX_KEY }));
  await mkdir(path.join(root, "data", "opencode"), { recursive: true });
  await writeFile(path.join(root, "data", "opencode", "auth.json"), JSON.stringify({ openrouter: { type: "api", key: MAC_OPENROUTER_KEY } }));
  // Every folder this Mac's agents keep their logins in is a fixture's; the machine's own are never read.
  const env = {
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: path.join(root, "home"),
    CODEX_HOME: path.join(root, "codex"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENORC_CLAUDE_BIN: path.join(bin, "claude"),
    OPENORC_CODEX_BIN: path.join(bin, "codex"),
  };
  for (const name of ["HOME", "CODEX_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const) vi.stubEnv(name, env[name]);
  claudeTokens = memoryStore();
  core = await OpenOrc.create({
    dataDir: path.join(root, "app"),
    ephemeral: true,
    transport: { push: () => undefined },
    shellProbe: inheritedProbe(env),
    claudeCloudSecrets: claudeTokens,
    codexCloudSecrets: memoryStore(),
    opencodeCloudSecrets: memoryStore(),
    cloudBrainSecrets: memoryStore(),
  });
});

afterEach(async () => {
  await core.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("brings every sign-in through the app: a token made in the browser, this Mac's keys copied", async () => {
  const before = await call("cloud.signIns", {});
  expect(before.rows.map(({ kind, state, way }) => ({ kind, state, way }))).toEqual([
    { kind: "claude", state: "missing", way: "browser" },
    { kind: "codex", state: "missing", way: "copy" },
    { kind: "opencode", state: "missing", way: "copy" },
  ]);
  expect((await call("cloud.signIns.bringAll", { copy: true })).bringing).toBe(true);
  await vi.waitFor(async () => expect((await call("cloud.signIns", {})).bringing).toBe(false), { timeout: 10_000 });
  expect((await call("cloud.signIns", {})).rows.map((row) => row.state)).toEqual(["ready", "ready", "ready"]);
  const status = await call("cloud.status", {});
  expect(status.codex.mode).toBe("apiKey");
  expect(status.opencode.providers).toEqual(["openrouter"]);
  expect(claudeTokens.saved.at(-1)).toContain(MINTED);
});

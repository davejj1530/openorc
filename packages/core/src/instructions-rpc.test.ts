import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects, threads } from "@openorc/db";
import type { CorePush, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let folder: string;
let personal: string;
let core: OpenOrc;
let threadId: string;
const pushed: CorePush[] = [];
let nextId = 1;

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = nextId++;
  await core.handle({ type: "rpc", id, method, params });
  const reply = pushed.find((m) => (m.type === "rpc.result" || m.type === "rpc.error") && m.id === id);
  if (!reply) throw new Error("no reply");
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return (reply as { result: RpcResults[M] }).result;
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-instructions-"));
  personal = await mkdtemp(path.join(os.tmpdir(), "openorc-instructions-home-"));
  // Personal files resolve under these folders, never the real home.
  vi.stubEnv("CLAUDE_CONFIG_DIR", personal);
  vi.stubEnv("CODEX_HOME", personal);
  core = await OpenOrc.create({ dataDir: folder, ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  const project = projects.insert(core.db, { name: "Instructions fixture", rootPath: folder, gitRemote: null, defaultBranch: null, settings: {} });
  threadId = threads.insert(core.db, { projectId: project.id, title: "Instructions", agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await core?.close();
  await rm(folder, { recursive: true, force: true });
  await rm(personal, { recursive: true, force: true });
});

describe("instruction files through RPC", () => {
  it("lists the thread agent's files, AGENTS.md first, including ones not created yet", async () => {
    await writeFile(path.join(folder, "CLAUDE.md"), "# Claude rules\n");
    const files = await call("instructions.list", { threadId });
    expect(files.map(({ scope, path: file, content }) => ({ scope, file, content }))).toEqual([
      { scope: "project", file: path.join(folder, "AGENTS.md"), content: "" },
      { scope: "project", file: path.join(folder, "CLAUDE.md"), content: "# Claude rules\n" },
      { scope: "personal", file: path.join(personal, "CLAUDE.md"), content: "" },
    ]);
    expect(files[0]!.version).toBeNull();
    expect(files[1]!.version).toEqual(expect.any(String));

    threads.update(core.db, threadId, { agent: "codex" });
    expect((await call("instructions.list", { threadId })).map((file) => file.path)).toEqual([path.join(folder, "AGENTS.md"), path.join(personal, "AGENTS.md")]);
  });

  it("creates a missing file and refuses a save that started from an older version", async () => {
    const target = path.join(folder, "AGENTS.md");
    const created = await call("instructions.save", { threadId, path: target, content: "Use pnpm.\n", version: null });
    expect(await readFile(target, "utf8")).toBe("Use pnpm.\n");

    // The agent edits the file while the person still has the first version open.
    await writeFile(target, "Use pnpm. Run tests first.\n");
    await expect(call("instructions.save", { threadId, path: target, content: "Use npm.\n", version: created.version })).rejects.toThrow("AGENTS.md changed after you started editing it.");
    expect(await readFile(target, "utf8")).toBe("Use pnpm. Run tests first.\n");

    const [current] = await call("instructions.list", { threadId });
    await call("instructions.save", { threadId, path: target, content: "Use npm.\n", version: current!.version });
    expect(await readFile(target, "utf8")).toBe("Use npm.\n");
  });

  it("writes only the agent's instruction files", async () => {
    await expect(call("instructions.save", { threadId, path: path.join(folder, "package.json"), content: "{}", version: null })).rejects.toThrow("not one of the conversation's instruction files");
  });

  it("lists a CLAUDE.md that links to AGENTS.md once, and saves through the link", async () => {
    await writeFile(path.join(folder, "AGENTS.md"), "Shared rules\n");
    await symlink("AGENTS.md", path.join(folder, "CLAUDE.md"));
    const files = await call("instructions.list", { threadId });
    expect(files.map((file) => path.basename(file.path))).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(files.map((file) => file.scope)).toEqual(["project", "personal"]);

    await call("instructions.save", { threadId, path: path.join(folder, "AGENTS.md"), content: "Shared rules, updated\n", version: files[0]!.version });
    expect(await readFile(path.join(folder, "CLAUDE.md"), "utf8")).toBe("Shared rules, updated\n");
  });
});

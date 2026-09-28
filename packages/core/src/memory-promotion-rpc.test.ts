import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memories, projects } from "@openorc/db";
import type { CorePush } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let folder: string;
let core: OpenOrc;
let memoryId: string;
const pushed: CorePush[] = [];

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "openorc-memory-promotion-"));
  core = await OpenOrc.create({ dataDir: folder, ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  const project = projects.insert(core.db, { name: "Promotion fixture", rootPath: folder, gitRemote: null, defaultBranch: null, settings: {} });
  memoryId = memories.upsert(core.db, { projectId: project.id, type: "decision", title: "Keep work", body: "Preserve existing instructions.", source: "user" }).memory.id;
  pushed.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core?.close();
  await fs.rm(folder, { recursive: true, force: true });
});

async function promote(file: "AGENTS.md" | "CLAUDE.md") {
  pushed.length = 0;
  await core.handle({ type: "rpc", id: 1, method: "memory.promote", params: { id: memoryId, file } });
  return pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === 1);
}

describe("memory promotion through RPC", () => {
  it.each(["CLAUDE.md"] as const)("creates missing %s and adds a memory only once", async (file) => {
    expect(await promote(file)).toMatchObject({ type: "rpc.result", result: { file } });
    const content = await fs.readFile(path.join(folder, file), "utf8");
    expect(content).toBe("## Project memory (from OpenOrc)\n- Keep work: Preserve existing instructions.\n");
    expect(await promote(file)).toMatchObject({ type: "rpc.result" });
    expect(await fs.readFile(path.join(folder, file), "utf8")).toBe(content);
    expect(core.db.stmt("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'memory.promote'").get()).toMatchObject({ count: 1 });
  });

  it("adds to an existing memory section without rewriting the user's instructions", async () => {
    const target = path.join(folder, "AGENTS.md");
    await fs.writeFile(target, "# Instructions\n\n## Project memory (from OpenOrc)\n- Existing memory\n");
    expect(await promote("AGENTS.md")).toMatchObject({ type: "rpc.result" });
    expect(await fs.readFile(target, "utf8")).toBe("# Instructions\n\n## Project memory (from OpenOrc)\n- Keep work: Preserve existing instructions.\n- Existing memory\n");
  });

  it.each(["EACCES"])("does not overwrite the existing file or record success after a %s read failure", async (code) => {
    const target = path.join(folder, "AGENTS.md");
    const original = "# Instructions\n\nUser-authored content must survive.\n";
    await fs.writeFile(target, original);
    vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error("Cannot read instructions"), { code }));
    const reply = await promote("AGENTS.md");
    expect(await fs.readFile(target, "utf8")).toBe(original);
    expect(reply).toMatchObject({ type: "rpc.error", message: "Cannot read instructions" });
    expect(core.db.stmt("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'memory.promote'").get()).toMatchObject({ count: 0 });
  });
});

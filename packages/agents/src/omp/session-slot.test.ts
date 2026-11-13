import { describe, expect, it } from "vitest";
import type { AgentHome, SavedSession, SessionId } from "../session-slot.js";
import { ompSlot } from "./session-slot.js";

const ID = "01a1bb1c-4b12-72e1-8afb-d77c0cfac145" as SessionId;

/** A ustar archive of the given files, as `omp session pack` writes one. */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(body.length.toString(8).padStart(11, "0"), 124);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const archive = (id: string = ID, version = 1) => tar({ "manifest.json": JSON.stringify({ version, id, cwd: "/work", omp: "18.18.1" }), "session.jsonl": '{"type":"session"}\n' });

/** A home whose CLI packs and unpacks from an in-memory store. */
function home(sessions: Map<string, Buffer>) {
  const files = new Map<string, Buffer>();
  const ran: string[][] = [];
  const at: AgentHome = {
    agent: "omp",
    machine: "sandbox",
    userHome: "/home/u",
    env: {},
    binary: "omp",
    read: async (file) => files.get(file) ?? null,
    write: async (file, bytes) => void files.set(file, bytes),
    remove: async (file) => void files.delete(file),
    list: async () => [],
    realpath: async (file) => file,
    run: async (args) => {
      ran.push([...args]);
      if (args[0] === "--version") return { code: 0, stdout: Buffer.from("omp/18.18.1"), stderr: "" };
      if (args[1] === "pack") {
        const found = sessions.get(args[2]!);
        if (!found) return { code: 1, stdout: Buffer.alloc(0), stderr: `Error: Session "${args[2]}" not found.` };
        files.set(args[3]!, found);
        return { code: 0, stdout: Buffer.from(args[3]!), stderr: "" };
      }
      if (args[1] === "unpack") {
        sessions.set(ID, files.get(args[2]!)!);
        return { code: 0, stdout: Buffer.from("/home/u/.omp/agent/sessions/x.jsonl"), stderr: "" };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: "unknown" };
    },
  };
  return { at, ran, files };
}

describe("Oh My Pi's conversations, moved", () => {
  it("packs a conversation into its one archive, and finds none before its first turn", async () => {
    const { at, files } = home(new Map([[ID, archive()]]));
    const saved = await ompSlot.export(at, { sessionId: ID, cwd: "/work", children: [] });
    expect(saved).toMatchObject({ agent: "omp", format: 1, sessionId: ID, parts: [{ name: "session.tar" }] });
    expect(files.size).toBe(0);
    expect(await ompSlot.export(at, { sessionId: "01a1bb1c-0000-7000-8000-000000000000" as SessionId, cwd: "/work", children: [] })).toBeNull();
  });

  it("unpacks one where it continues and reads back what that home now holds", async () => {
    const sessions = new Map<string, Buffer>();
    const { at, ran } = home(sessions);
    const saved: SavedSession = { agent: "omp", format: 1, cliVersion: null, sessionId: ID, parts: [{ name: "session.tar", bytes: archive() }], meta: {} };
    const digest = await ompSlot.import(at, saved, "/sandbox/repo");
    expect(ran.find((args) => args[1] === "unpack")).toEqual(["session", "unpack", expect.stringMatching(/openorc-transfer\/.+\.tar$/), "--cwd", "/sandbox/repo"]);
    expect(digest).toBe(ompSlot.digest(saved));
  });

  it("refuses an archive of another conversation or format before writing anything", async () => {
    const { at, ran } = home(new Map());
    const of = (bytes: Buffer): SavedSession => ({ agent: "omp", format: 1, cliVersion: null, sessionId: ID, parts: [{ name: "session.tar", bytes }], meta: {} });
    await expect(ompSlot.import(at, of(archive("someone-else")), "/repo")).rejects.toThrow("another conversation");
    await expect(ompSlot.import(at, of(archive(ID, 2)), "/repo")).rejects.toThrow("format");
    expect(ran).toEqual([]);
  });

  it("continues a conversation headless, asking nothing unless it is autonomous", () => {
    const autonomous = ompSlot.continueOnce({ sessionId: ID }, "Carry on", { model: "anthropic/claude-haiku-5-5", effort: "low", mode: "act", permissionMode: "autonomous" });
    expect(autonomous.args).toEqual(
      expect.arrayContaining(["-p", "--mode", "json", "--resume", ID, "--model", "anthropic/claude-haiku-5-5", "--thinking", "low", "--approval-mode", "yolo", "Carry on"]),
    );
    expect(ompSlot.continueOnce({ sessionId: ID }, "x", { model: null, effort: null, mode: "plan", permissionMode: "autonomous" }).args).toEqual(
      expect.arrayContaining(["--approval-mode", "always-ask"]),
    );
  });
});

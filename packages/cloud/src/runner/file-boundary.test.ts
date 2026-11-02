import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileBoundaryAnswer as macAnswer } from "@openorc/mcp/file-boundary";
import { fileBoundaryUrl, type FileBoundary } from "@openorc/protocol";
import { fileBoundaryAnswer as vmAnswer } from "./file-boundary.ts";

const base = mkdtempSync(path.join(os.tmpdir(), "openorc-boundary-"));
const root = path.join(base, "repo");
mkdirSync(path.join(root, "src"), { recursive: true });
writeFileSync(path.join(root, "src", "a.ts"), "");
mkdirSync(path.join(base, "elsewhere"));
symlinkSync(path.join(base, "elsewhere"), path.join(root, "escape"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const boundaries: FileBoundary[] = [
  { root, cwd: root, outside: "ask" },
  { root: path.join(root, "src"), cwd: root, outside: "deny" },
];
const requests: unknown[] = [
  { tool_input: { file_path: "src/a.ts" } },
  { tool_input: { file_path: "src/new/b.ts" } },
  { tool_input: { file_path: "escape/c.ts" } },
  { tool_input: { file_path: "../outside.ts" } },
  { tool_input: { notebook_path: "/etc/hosts" } },
  { tool_input: { file_path: root } },
  { tool_input: {} },
];

const settle = (answer: () => unknown) => {
  try {
    return { answer: answer() };
  } catch {
    return { refused: true };
  }
};

describe("the runner's file-boundary check", () => {
  it("answers every request as the Mac's check does", () => {
    for (const boundary of boundaries)
      for (const request of requests) {
        const query = new URL(fileBoundaryUrl("http://127.0.0.1:1/mcp/t", boundary)).searchParams;
        expect(
          settle(() => vmAnswer(query, request)),
          JSON.stringify({ boundary, request }),
        ).toEqual(settle(() => macAnswer(boundary, request)));
      }
  });
});

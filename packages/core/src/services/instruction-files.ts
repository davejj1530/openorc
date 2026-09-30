import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstructionFile } from "@openorc/protocol";

type Location = Pick<InstructionFile, "scope" | "path">;

const MAX_BYTES = 2 * 1024 * 1024;

/** Each location as it is on disk. A file that links to an earlier one, like a CLAUDE.md pointing at AGENTS.md, is listed once. */
export async function readInstructionFiles(locations: Location[]): Promise<InstructionFile[]> {
  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const location of locations) {
    const real = await realpath(location.path).catch(() => location.path);
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(await readInstructionFile(location));
  }
  return files;
}

/**
 * Refuses a file that changed after `version` was read, so an agent's edit is never overwritten unseen. Writing
 * through links keeps a CLAUDE.md that points at AGENTS.md pointing there.
 */
export async function saveInstructionFile(location: Location, content: string, version: string | null): Promise<InstructionFile> {
  const current = await readInstructionFile(location);
  if (current.version !== version) throw new Error(`${path.basename(location.path)} changed after you started editing it.`);
  await mkdir(path.dirname(location.path), { recursive: true });
  await writeFile(location.path, content);
  return { ...location, content, version: versionOf(Buffer.from(content)) };
}

async function readInstructionFile(location: Location): Promise<InstructionFile> {
  const name = path.basename(location.path);
  let bytes: Buffer;
  try {
    bytes = await readFile(location.path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...location, content: "", version: null };
    throw error;
  }
  if (bytes.length > MAX_BYTES) throw new Error(`${name} is too large to edit here (2 MB maximum).`);
  try {
    return { ...location, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), version: versionOf(bytes) };
  } catch {
    throw new Error(`${name} is not UTF-8 text.`);
  }
}

const versionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

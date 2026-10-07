import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { FileVersion, FolderPath, type InstructionFile } from "@openorc/protocol";
import { versionOf } from "./file-write.js";
import type { FileService } from "./files.js";

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
 * Refuses a file that changed after `version` was read, so an agent's edit is never overwritten unseen. Writes
 * through links, so a CLAUDE.md that points at AGENTS.md keeps pointing there.
 */
export async function saveInstructionFile(files: Pick<FileService, "save">, location: Location, content: string, version: string | null): Promise<InstructionFile> {
  const target = await realpath(location.path).catch(() => location.path);
  await mkdir(path.dirname(target), { recursive: true });
  const root = await realpath(path.dirname(target));
  const expected = version === null ? { kind: "absent" as const } : { kind: "version" as const, version: FileVersion.parse(version) };
  const outcome = await files.save(root, FolderPath.parse(path.basename(target)), content, expected);
  if (outcome.kind === "conflict") throw new Error(`${path.basename(location.path)} changed after you started editing it.`);
  return { ...location, content, version: outcome.version };
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

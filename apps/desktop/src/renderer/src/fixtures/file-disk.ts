import { FileVersion, FolderPath, type FileDirectory, type FileEntry, type FileRead, type FileWriteResult, type RpcParams } from "@openorc/protocol";

/** The nth version a fake disk hands out, so a test can name the version it expects. */
export const nthVersion = (n: number) => FileVersion.parse(String(n).padStart(64, "0"));

/**
 * A folder at /repo answering files.read and files.write as the core does: versions change on every write, a save is
 * refused with the file as it is now unless the file is still as expected, and `absent` only creates.
 */
export function fakeFileDisk() {
  let versions = 0;
  const files = new Map<string, { text: string; version: FileVersion; readOnly?: string }>();
  const ignored = new Set<string>();
  const writes: RpcParams<"files.write">[] = [];
  const read = (path: string): FileRead => {
    const local = FolderPath.parse(path.replace(/^\/repo\//, ""));
    const file = files.get(local);
    if (!file) return { kind: "missing", root: "/repo", path: local };
    return { kind: "file", root: "/repo", path: local, absolutePath: `/repo/${local}`, version: file.version, text: file.text, readOnly: file.readOnly ?? null };
  };
  return {
    files,
    ignored,
    writes,
    read,
    list(path: string): FileDirectory {
      const prefix = path ? `${path}/` : "";
      const entries = new Map<string, FileEntry>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        if (!name) continue;
        entries.set(name, { name, path: FolderPath.parse(prefix + name), kind: rest.length ? "directory" : "file", ignored: ignored.has(prefix + name) });
      }
      return { root: "/repo", entries: [...entries.values()].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)) };
    },
    /** Changes a file as an agent or a terminal would, or deletes it with null. */
    set(path: string, text: string | null, readOnly?: string): void {
      if (text === null) files.delete(path);
      else files.set(path, { text, version: nthVersion(++versions), ...(readOnly ? { readOnly } : {}) });
    },
    write(params: RpcParams<"files.write">): FileWriteResult {
      writes.push(params);
      const current = files.get(params.path);
      const expected = params.expected.kind === "absent" ? !current : current?.version === params.expected.version;
      if (!expected) return { kind: "conflict", current: read(params.path) };
      const version = nthVersion(++versions);
      files.set(params.path, { text: params.text, version });
      return { kind: "saved", root: "/repo", path: params.path, absolutePath: `/repo/${params.path}`, version, text: null, formatError: null };
    },
  };
}

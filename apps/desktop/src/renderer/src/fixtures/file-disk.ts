import { FileVersion, FolderPath, type FileRead, type FileWriteResult, type RpcParams } from "@openorc/protocol";

/** The nth version a fake disk hands out, so a test can name the version it expects. */
export const nthVersion = (n: number) => FileVersion.parse(String(n).padStart(64, "0"));

/**
 * A folder at /repo answering files.read and files.write as the core does: versions change on every write, a save is
 * refused with the file as it is now unless the file is still as expected, and `absent` only creates.
 */
export function fakeFileDisk() {
  let versions = 0;
  const files = new Map<string, { text: string; version: FileVersion; readOnly?: string }>();
  const writes: RpcParams<"files.write">[] = [];
  const read = (path: string): FileRead => {
    const local = FolderPath.parse(path.replace(/^\/repo\//, ""));
    const file = files.get(local);
    if (!file) return { kind: "missing", root: "/repo", path: local };
    return { kind: "file", root: "/repo", path: local, absolutePath: `/repo/${local}`, version: file.version, text: file.text, readOnly: file.readOnly ?? null };
  };
  return {
    files,
    writes,
    read,
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

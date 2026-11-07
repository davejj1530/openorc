import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentHostFile {
  path: string;
  content: string;
}

/**
 * Where a provider's CLI runs when it is not this Mac, such as a cloud sandbox. Every path is the host's own. The
 * process it starts is shaped like a local child process but has no pid, so local process-group handling passes over it.
 */
export interface AgentHost {
  /** The home folder of the host's user, where the CLI keeps its own configuration. */
  readonly home: string;
  /** A private folder on the host for one process's files, such as its MCP configuration. */
  privateDir(runId: string): string;
  /** The address on the host that reaches `url` on this Mac. */
  localUrl(url: string): string;
  /** Makes `dirs` and writes `files` (readable only by the host's user), then starts the CLI. */
  spawn(binary: string, args: string[], options: { runId: string; cwd: string; env: Record<string, string>; files: AgentHostFile[]; dirs: string[] }): ChildProcessWithoutNullStreams;
  /** Copies files from this Mac onto the host and returns their paths there, in order. */
  upload(paths: string[]): Promise<string[]>;
}

/** Where an adapter puts what the CLI reads before it starts: this Mac's disk, or files a host writes as the CLI starts. */
export interface LaunchPlace {
  readonly home: string;
  readonly host: AgentHost | null;
  /** Files and folders a host writes when it starts the CLI. Empty on this Mac, where they are written straight away. */
  readonly files: AgentHostFile[];
  readonly dirs: string[];
  privateDir(runId: string): string;
  write(file: string, content: string): void;
  mkdir(dir: string): void;
  url(url: string): string;
  /** Removes a private folder this place made. A host's folders stay with the host. */
  remove(dir: string): void;
}

/** A host takes only variables with values. */
export function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function launchPlace(host: AgentHost | undefined): LaunchPlace {
  if (!host)
    return {
      home: os.homedir(),
      host: null,
      files: [],
      dirs: [],
      privateDir: () => mkdtempSync(path.join(os.tmpdir(), "openorc-claude-")),
      write: (file, content) => writeFileSync(file, content, { mode: 0o600 }),
      mkdir: (dir) => mkdirSync(dir, { recursive: true }),
      url: (url) => url,
      remove: (dir) => rmSync(dir, { recursive: true, force: true }),
    };
  const files: AgentHostFile[] = [];
  const dirs: string[] = [];
  return {
    home: host.home,
    host,
    files,
    dirs,
    privateDir: (runId) => host.privateDir(runId),
    write: (file, content) => files.push({ path: file, content }),
    mkdir: (dir) => dirs.push(dir),
    url: (url) => host.localUrl(url),
    remove: () => undefined,
  };
}

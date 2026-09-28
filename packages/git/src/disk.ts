import { run } from "./exec.js";

/** Bytes on disk under a path, via the platform's du. Returns 0 when the path is gone. */
export async function diskUsage(dir: string): Promise<number> {
  try {
    const r = await run("du", dir, ["-sk", "."], { timeoutMs: 30_000 });
    const kb = Number(r.stdout.trim().split(/\s+/)[0] ?? 0);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

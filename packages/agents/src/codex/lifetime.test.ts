import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAdapter } from "./adapter.js";

it.skipIf(process.platform === "win32")("closing a CLI wrapper also ends its native session writer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-writer-"));
  const childFile = path.join(dir, "writer.cjs");
  const wrapper = path.join(dir, "wrapper");
  const pidFile = path.join(dir, "writer.pid");
  await writeFile(
    childFile,
    `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r = JSON.parse(line);
      if (r.id) process.stdout.write(JSON.stringify({id:r.id,result:r.method==='thread/start'?{thread:{id:'fixture'}}:{}})+'\\n');
    });
    setInterval(() => {}, 1000);
  `,
  );
  await writeFile(wrapper, `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath, [${JSON.stringify(childFile)}], {stdio:'inherit'});\n`, { mode: 0o755 });
  let pid: number | undefined;
  const handle = new CodexAdapter({ binary: wrapper, onApproval: async () => "deny" }).start(
    { runId: "lifetime", agent: "codex", cwd: dir, permissionMode: "autonomous", prompt: "Fixture only" },
    { revision: 0, binary: wrapper, env: process.env },
  );
  try {
    await handle.next("session.started", 3000);
    pid = Number(await readFile(pidFile, "utf8"));
    handle.close();
    await handle.wait();
    await expect
      .poll(
        () => {
          try {
            process.kill(pid!, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 1500 },
      )
      .toBe(false);
  } finally {
    handle.close();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
});

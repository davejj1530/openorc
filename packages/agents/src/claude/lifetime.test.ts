import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ClaudeAdapter } from "./adapter.js";

it.skipIf(process.platform === "win32")(
  "proves physical closure after a signal races a naturally completed print process",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openorc-claude-exit-"));
    const binary = path.join(directory, "successful-print");
    await writeFile(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'result',subtype:'success',result:'Completed fixture',duration_ms:1,num_turns:1}));\n`, { mode: 0o755 });
    try {
      for (let index = 0; index < 10; index++) {
        const handle = new ClaudeAdapter({ binary }).start(
          { runId: `fixture-${index}`, agent: "claude", cwd: directory, permissionMode: "trusted", prompt: "Local fixture only" },
          { revision: 0, binary, env: process.env },
        );
        const errors: unknown[] = [];
        let close!: () => void;
        const requested = new Promise<void>((resolve) => {
          close = resolve;
        });
        handle.on("event", (event) => {
          if (event.type === "error" && event.fatal) errors.push(event.message);
          if (event.type === "turn.completed")
            setTimeout(() => {
              // A disappearing Darwin group can briefly reject the signal. The
              // caller still must wait for confirmed closure before releasing it.
              try {
                handle.close();
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EPERM") errors.push(error);
              }
              close();
            }, 0);
        });
        await requested;
        await handle.wait();
        expect(errors).toEqual([]);
        expect(() => handle.close()).not.toThrow();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  5000,
);

it.skipIf(process.platform === "win32")(
  "waits for a redirected child writer even after its CLI wrapper exits",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openorc-claude-writer-"));
    const wrapper = path.join(directory, "wrapper");
    const childFile = path.join(directory, "child.cjs");
    const pidFile = path.join(directory, "child.pid");
    const marker = path.join(directory, "writes.txt");
    // The child ignores SIGTERM on purpose. A run interrupted before `finally` (a timeout, or a sandbox that refuses
    // process-group signals) cannot stop it, so it ends itself rather than writing for days.
    await writeFile(
      childFile,
      `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'write\\n'),20); setTimeout(()=>process.exit(0),60000);`,
    );
    await writeFile(
      wrapper,
      `#!${process.execPath}\nconst fs=require('node:fs'); require('node:child_process').spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore'}); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(t);process.exit(0)}},10);\n`,
      { mode: 0o755 },
    );
    const handle = new ClaudeAdapter({ binary: wrapper }).start(
      { runId: "fixture", agent: "claude", cwd: directory, permissionMode: "trusted", prompt: "Fixture only" },
      { revision: 0, binary: wrapper, env: process.env },
    );
    let pid: number | undefined;
    try {
      await expect.poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0")), { timeout: 3000 }).toBeGreaterThan(0);
      pid = Number(await readFile(pidFile, "utf8"));
      let finished = false;
      const done = handle.wait().then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(finished).toBe(false);
      await done;
      expect(() => process.kill(pid!, 0)).toThrow();
      const captured = await readFile(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await readFile(marker, "utf8")).toBe(captured);
    } finally {
      handle.close();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

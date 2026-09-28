import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCodexUsage } from "./usage.js";

it.skipIf(process.platform === "win32")("reads allowance without starting a turn and closes the CLI wrapper's child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openorc-usage-"));
  const child = join(dir, "server.cjs");
  const wrapper = join(dir, "codex");
  const pidFile = join(dir, "pid");
  const calls = join(dir, "calls");
  await writeFile(
    child,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(calls)}, r.method + '\\n');
      if (!r.id) return;
      const result = r.method === 'account/read' ? { account: {type:'chatgpt'} } : r.method === 'account/rateLimits/read' ? {rateLimits:{primary:{usedPercent:25}}} : {};
      process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
    });
    setInterval(() => {}, 1000);
  `,
  );
  await writeFile(wrapper, `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'});\n`, { mode: 0o755 });
  let pid: number | undefined;
  try {
    expect(await readCodexUsage({ binary: wrapper, env: process.env })).toMatchObject({ account: { type: "chatgpt" }, limits: { rateLimits: { primary: { usedPercent: 25 } } } });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    pid = Number(await readFile(pidFile, "utf8"));
    await expect
      .poll(() => {
        try {
          process.kill(pid!, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
});

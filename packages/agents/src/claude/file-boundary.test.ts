import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fileBoundaryUrl, type FileBoundary } from "@openorc/protocol";
import { fileBoundaryHook } from "./file-boundary.js";

const boundary: FileBoundary = { root: "/tmp/plans dir", cwd: "/tmp/project", outside: "deny" };
const request = { tool_name: "Write", tool_input: { file_path: "/tmp/plans dir/plan.md" } };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((step) => step()));

/** Runs the hook as Claude Code does, with a .curlrc and a proxy that would break it if curl used them. */
function runHook(command: string, home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home, http_proxy: "http://127.0.0.1:9" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

/** A stand-in for OpenOrc's server that records each request and answers with `status`. */
async function openOrc(status: number) {
  const received: { url: string; host: string | undefined; body: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url ?? "", host: req.headers.host, body });
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ answered: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/run-secret`;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup.push(() => void close());
  return { mcpUrl, received, close };
}

function privateDirs() {
  const dir = mkdtempSync(path.join(tmpdir(), "openorc-hook-"));
  const home = mkdtempSync(path.join(tmpdir(), "openorc-home-"));
  writeFileSync(path.join(home, ".curlrc"), 'proxy = "http://127.0.0.1:9"\n');
  cleanup.push(() => [dir, home].forEach((each) => rmSync(each, { recursive: true, force: true })));
  return { dir, home };
}

it.skipIf(process.platform === "win32")("posts each edit to the run's address and prints OpenOrc's answer, keeping the secret out of the command", async () => {
  const { dir, home } = privateDirs();
  const server = await openOrc(200);
  const command = fileBoundaryHook(boundary, { mcpUrl: server.mcpUrl, dir });
  expect(command).not.toContain("run-secret");
  const config = path.join(dir, "file-boundary.curlrc");
  expect(statSync(config).mode & 0o777).toBe(0o600);
  expect(readFileSync(config, "utf8")).toContain(fileBoundaryUrl(server.mcpUrl, boundary));

  const result = await runHook(command, home);
  expect(result).toMatchObject({ code: 0, stdout: JSON.stringify({ answered: true }) });
  const hookUrl = new URL(fileBoundaryUrl(server.mcpUrl, boundary));
  expect(server.received).toEqual([{ url: hookUrl.pathname + hookUrl.search, host: hookUrl.host, body: JSON.stringify(request) }]);
});

it.skipIf(process.platform === "win32")("blocks the tool when OpenOrc refuses, does not answer, or was never connected", async () => {
  const { dir, home } = privateDirs();
  const refusing = await openOrc(422);
  const blocked = { code: 2, stdout: "", stderr: expect.stringContaining("OpenOrc could not check this file path") };
  expect(await runHook(fileBoundaryHook(boundary, { mcpUrl: refusing.mcpUrl, dir }), home)).toMatchObject(blocked);

  const gone = await openOrc(200);
  const command = fileBoundaryHook(boundary, { mcpUrl: gone.mcpUrl, dir });
  await gone.close();
  expect(await runHook(command, home)).toMatchObject(blocked);

  expect(await runHook(fileBoundaryHook(boundary, null), home)).toMatchObject(blocked);
});

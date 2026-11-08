/**
 * Installs a CLI that ships as one prebuilt binary, the way its own installer does: its build service names the file
 * for this Linux machine and its sha256, the download is checked against that, and only then does it replace `dest`.
 * Run as `node -e <this> <service> <version or ""> <dest>`, so a machine with Node needs nothing else.
 */
export const PREBUILT_INSTALL = `
const [service, version, dest] = process.argv.slice(1);
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { execFileSync } = require("node:child_process");
const fail = (message) => { console.error(message); process.exit(1); };
const arch = { x64: "x86_64", arm64: "arm64" }[process.arch];
if (process.platform !== "linux" || !arch) fail("No prebuilt binary for " + process.platform + " " + process.arch + ".");
let musl = fs.existsSync("/etc/alpine-release");
try { musl = musl || /musl/i.test(execFileSync("ldd", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
catch (error) { musl = musl || /musl/i.test(String(error.stderr || "")); }
const target = (musl ? "linux-musl-" : "linux-") + arch;
const url = version ? service + "/versions/" + encodeURIComponent(version) + "/" + target : service + "/latest/" + target + "?channel=stable";
(async () => {
  const answer = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!answer.ok) fail("The build service has no " + target + " build" + (version ? " of " + version : "") + " (" + answer.status + ").");
  const build = await answer.json();
  const sha256 = build && build.file && build.file.sha256;
  if (typeof build.download !== "string" || !/^https:\\/\\//.test(build.download) || !/^[0-9a-f]{64}$/.test(String(sha256))) fail("The build service answered with no file to check.");
  const part = dest + ".download-" + process.pid;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const download = await fetch(build.download, { signal: AbortSignal.timeout(120000) });
    if (!download.ok || !download.body) throw new Error("The download failed (" + download.status + ").");
    const hash = crypto.createHash("sha256");
    await pipeline(download.body, async function* (chunks) {
      for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
    }, fs.createWriteStream(part, { mode: 0o755, flags: "wx" }));
    if (hash.digest("hex") !== sha256) throw new Error("The download does not match its checksum.");
    fs.chmodSync(part, 0o755);
    fs.renameSync(part, dest);
  } finally {
    fs.rmSync(part, { force: true });
  }
})().catch((error) => fail(String((error && error.message) || error)));
`;

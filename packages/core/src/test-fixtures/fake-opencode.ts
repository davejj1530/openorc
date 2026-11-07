/**
 * Stands in for OpenCode's session commands and its ACP resume, keeping each session as one JSON file under
 * XDG_DATA_HOME, as its export prints it. Like OpenCode 2.0.11: import keeps the id and takes the folder it is given,
 * refuses a child before its parent, says "Session already exists" on stderr (exit 0) for an id it holds, "Session not
 * found" on stderr (exit 1), and delete takes the children with it. Every call appends its arguments to FAKE_OPENCODE_LOG when set.
 */
export const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_OPENCODE_LOG) fs.appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("opencode v2.0.11"); process.exit(0); }
const store = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local", "share"), "fake-opencode");
const file = (id) => path.join(store, id + ".json");
const read = (id) => (fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), "utf8")) : null);
const real = (dir) => { try { return fs.realpathSync(dir); } catch { return dir; } };
const rest = args.filter((arg) => arg !== "--standalone");
if (rest[0] === "session") {
  const [, verb, ...more] = rest;
  if (verb === "export") {
    const session = read(more[0]);
    if (!session) { console.error("Session not found: " + more[0]); process.exit(1); }
    process.stdout.write(JSON.stringify(session));
    process.exit(0);
  }
  if (verb === "delete") {
    if (!read(more[0])) { console.error("Session not found: " + more[0]); process.exit(1); }
    for (const name of fs.readdirSync(store)) if (JSON.parse(fs.readFileSync(path.join(store, name), "utf8")).info.parentID === more[0]) fs.rmSync(path.join(store, name));
    fs.rmSync(file(more[0]));
    console.log("Session " + more[0] + " deleted");
    process.exit(0);
  }
  if (verb === "import") {
    const directory = more[more.indexOf("--directory") + 1];
    const session = JSON.parse(fs.readFileSync(more.at(-1), "utf8"));
    if (read(session.info.id)) { console.error("Session already exists"); process.exit(0); }
    if (session.info.parentID && !read(session.info.parentID)) { console.error("SessionNotFoundError: " + session.info.parentID); process.exit(1); }
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(file(session.info.id), JSON.stringify({ ...session, info: { ...session.info, location: { directory }, time: { ...session.info.time, updated: Date.now() } } }));
    console.log("Imported session: " + session.info.id);
    process.exit(0);
  }
}
if (rest[0] === "acp") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) + "\\n");
    if (message.method !== "session/resume") return reply({ result: { protocolVersion: 1 } });
    const session = read(message.params.sessionId);
    if (!session) return reply({ error: { code: -32602, message: "session not found" } });
    if (real(session.info.location.directory) !== real(message.params.cwd)) return reply({ error: { code: -32602, message: "Invalid params: session " + session.info.id + " does not belong to cwd: " + message.params.cwd } });
    reply({ result: { configOptions: [] } });
  });
} else {
  console.error("unknown command " + args.join(" "));
  process.exit(2);
}
`;

import { CodexAdapter } from "../src/codex/adapter.js";

const [binary, cwd, registry] = process.argv.slice(2);
const handle = new CodexAdapter({ binary, onApproval: async () => "deny" }).start(
  { runId: "crash-fixture", agent: "codex", cwd: cwd!, permissionMode: "autonomous", prompt: "Fixture only" },
  { revision: 0, binary: binary!, env: process.env, processRegistry: registry },
);
await handle.next("session.started", 5000);
process.send?.("ready");

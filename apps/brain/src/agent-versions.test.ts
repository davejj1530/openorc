import { expect, it } from "vitest";
import { alignAgents, type Run } from "./agent-versions.js";

/** The brain's npm folder: each CLI at a version, and npm installing `pkg@version` into it. */
function machine(installed: Record<string, string>, failing: string[] = []) {
  const installs: { spec: string; prefix: string | undefined }[] = [];
  const exec: Run = async (file, args, env) => {
    if (file === "npm") {
      const spec = args.at(-1)!;
      installs.push({ spec, prefix: env?.["NPM_CONFIG_PREFIX"] });
      const [, name = "", version = ""] = /^(@?[^@]+)@(.+)$/.exec(spec) ?? [];
      if (failing.includes(name)) return { code: 1, stdout: "" };
      installed[{ "@anthropic-ai/claude-code": "claude", "@openai/codex": "codex", "@opencode/cli": "opencode" }[name]!] = version;
      return { code: 0, stdout: "" };
    }
    const bin = file.split("/").at(-1)!;
    return installed[bin] ? { code: 0, stdout: `${bin} ${installed[bin]}\n` } : { code: 127, stdout: "" };
  };
  return { exec, installs };
}

it("installs, in its own npm folder, each agent CLI whose version differs from the Mac's, and answers what it has after", async () => {
  const brain = machine({ claude: "2.1.317", codex: "0.165.0" });
  const answer = await alignAgents("/brain/npm", { claude: "2.1.317", codex: "0.166.0", opencode: "2.0.11", omp: null, cursor: null, pi: null, antigravity: null, fx: null }, brain.exec);
  expect(brain.installs).toEqual([
    { spec: "@openai/codex@0.166.0", prefix: "/brain/npm" },
    { spec: "@opencode/cli@2.0.11", prefix: "/brain/npm" },
  ]);
  expect(answer).toEqual({ versions: { claude: "2.1.317", codex: "0.166.0", opencode: "2.0.11", omp: null, cursor: null, pi: null, antigravity: null, fx: null } });
});

it("keeps its own where the Mac knows none, and answers the version it kept when an install fails", async () => {
  const brain = machine({ claude: "2.1.300", codex: "0.165.0" }, ["@openai/codex"]);
  const answer = await alignAgents("/brain/npm", { claude: null, codex: "0.166.0", opencode: null, omp: null, cursor: null, pi: null, antigravity: null, fx: null }, brain.exec);
  expect(brain.installs.map((install) => install.spec)).toEqual(["@openai/codex@0.166.0"]);
  expect(answer).toEqual({ versions: { claude: "2.1.300", codex: "0.165.0", opencode: null, omp: null, cursor: null, pi: null, antigravity: null, fx: null } });
});

it("does not probe or install local-only agents reported by the Mac", async () => {
  const calls: string[] = [];
  const answer = await alignAgents(
    "/brain/npm",
    { claude: null, codex: null, opencode: null, omp: null, cursor: "2026.11.05-abc123", pi: "1.5.0", antigravity: "1.5.3", fx: "0.0.16" },
    async (file) => {
      calls.push(file);
      return { code: 127, stdout: "" };
    },
  );
  expect(calls).toEqual(["/brain/npm/bin/codex", "/brain/npm/bin/claude", "/brain/npm/bin/opencode", "/brain/npm/bin/omp"]);
  expect(answer.versions).toMatchObject({ cursor: null, pi: null, antigravity: null, fx: null });
});

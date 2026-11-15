/**
 * Claude Code hides its Artifact tool in print mode, which every OpenOrc launch uses, unless `CLAUDE_CODE_ARTIFACT` is
 * set. This sets it; a value the user chose, 0 included, wins. The switch is Claude Code's own and undocumented: if it
 * goes away, the tool stays hidden.
 */
export function withArtifactTool(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env["CLAUDE_CODE_ARTIFACT"] === undefined ? { ...env, CLAUDE_CODE_ARTIFACT: "1" } : env;
}

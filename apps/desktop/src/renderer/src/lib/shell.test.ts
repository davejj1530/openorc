import { expect, it } from "vitest";
import { commandLine, shellSteps, shellTokens, unwrapShell } from "./shell";

const texts = (command: string) => shellSteps(command).map((step) => step.text);

it("splits a command where the shell runs one thing after another", () => {
  expect(texts("cd /repo && rg -n 'a;b' src; git status --short\npnpm test")).toEqual(["cd /repo", "rg -n 'a;b' src", "git status --short", "pnpm test"]);
  // Pipes, `||`, loops, conditionals, subshells and substitutions stay whole.
  expect(texts("for f in a b; do\n  echo $f; done; test -f x || echo missing; (cd a && ls) | head")).toEqual(["for f in a b; do\n  echo $f; done", "test -f x || echo missing", "(cd a && ls) | head"]);
  expect(texts("if [ -f x ]; then echo y; fi && echo $(date; echo ${#x}) # when")).toEqual(["if [ -f x ]; then echo y; fi", "echo $(date; echo ${#x}) # when"]);
  expect(texts("# look first\nrg -n x \\\n  src")).toEqual(["# look first", "rg -n x \\\n  src"]);
});

it("keeps a heredoc's body apart from the line that feeds it", () => {
  expect(shellSteps("cd /tmp && python3 - <<'PY'\nimport json\nprint(1); print(2)\nPY\ncat <<EOF > notes.md\n# Notes\nEOF\nls")).toEqual([
    { text: "cd /tmp", input: null },
    { text: "python3 -", input: "import json\nprint(1); print(2)" },
    { text: "cat > notes.md", input: "# Notes" },
    { text: "ls", input: null },
  ]);
  expect(shellSteps("cat <<-EOF\n\tindented\n\tEOF")).toEqual([{ text: "cat", input: "indented" }]);
});

it("reads a step's words as the shell would", () => {
  expect(commandLine(`rg -n "foo bar" 'src/a b' 2>/dev/null | head -20`)).toEqual({ words: ["rg", "-n", "foo bar", "src/a b"], next: ["head"], output: null });
  expect(commandLine("npx tsc > /tmp/out.txt 2>&1")).toEqual({ words: ["npx", "tsc"], next: [], output: { path: "/tmp/out.txt", append: false } });
  expect(commandLine("echo $(ls -1 | wc -l) >> log.txt")).toEqual({ words: ["echo", "$(ls -1 | wc -l)"], next: [], output: { path: "log.txt", append: true } });
  expect(shellTokens("node -e 'a\nb' # run it").map((token) => token.value)).toEqual(["node", "-e", "a\nb"]);
});

it("unwraps the shell Codex runs a command in", () => {
  expect(unwrapShell(`/bin/zsh -lc "python3 - <<'PY'\nprint(\\"hi\\")\nPY"`)).toBe(`python3 - <<'PY'\nprint("hi")\nPY`);
  expect(unwrapShell(`/bin/zsh -lc 'echo '"'"'quoted'"'"' ok'`)).toBe("echo 'quoted' ok");
  expect(unwrapShell("/bin/zsh -lc rg -n foo src")).toBe("rg -n foo src");
  expect(unwrapShell("ls")).toBe("ls");
});

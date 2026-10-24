import { describe, expect, it } from "vitest";
import { readCommand, searchTerms, type CommandAction } from "./command-reader.js";

/** Each action as one readable line: its kind, what it names, then its faint details. */
function view(action: CommandAction): string {
  const line = (kind: string, ...parts: (string | null | undefined)[]) => `${kind} ${parts.filter(Boolean).join(" · ")}`;
  switch (action.type) {
    case "read":
      return line("read", action.path, action.range);
    case "search":
      return line("search", action.query, action.scope, action.countable ? "counts" : "");
    case "listFiles":
      return line("list", action.path, action.pattern);
    case "unknown":
      return action.run ? line("run", action.run.label, action.run.detail) : `raw ${action.command}`;
  }
}
const read = (command: string) => readCommand(command).map(view);

// Commands below come from real Claude and Codex calls in the app's ledger.
describe("reads", () => {
  it("keeps the file and the lines a read printed", () => {
    expect(read("sed -n 70,100p components/Sidebar.tsx")).toEqual(["read components/Sidebar.tsx · lines 70–100"]);
    expect(read(`/bin/zsh -lc "sed -n '35,75p' apps/desktop/src/renderer/src/App.onboarding.test.tsx"`)).toEqual(["read apps/desktop/src/renderer/src/App.onboarding.test.tsx · lines 35–75"]);
    expect(read("/bin/zsh -lc 'tail -n 10 /tmp/orcquest-modelpicker-profile.log'")).toEqual(["read /tmp/orcquest-modelpicker-profile.log · last 10 lines"]);
    expect(read("head -60 next.config.ts")).toEqual(["read next.config.ts · first 60 lines"]);
    expect(read("sed -n 12p a.ts")).toEqual(["read a.ts · line 12"]);
    expect(read("nl -ba src/status.tsx | sed -n '120,200p'")).toEqual(["read src/status.tsx · lines 120–200"]);
    expect(read("cat packages/db/src/pull-review-schema.ts | head -40")).toEqual(["read packages/db/src/pull-review-schema.ts · first 40 lines"]);
    expect(read("awk 'NR>=10 && NR<=20' notes.md")).toEqual(["read notes.md · lines 10–20"]);
  });

  it("reads each file a read names, from the folder a cd moved to", () => {
    expect(read("cd /Users/david/dev/misc/sma/sma-3-monorepo/apps/api && cat src/worker.ts src/worker.module.ts")).toEqual([
      "read /Users/david/dev/misc/sma/sma-3-monorepo/apps/api/src/worker.ts",
      "read /Users/david/dev/misc/sma/sma-3-monorepo/apps/api/src/worker.module.ts",
    ]);
    expect(read(`sed -n 76,84p "/Users/david/Library/Application Support/Orcquest/skills/lib/cdp.mjs"`)).toEqual([
      "read /Users/david/Library/Application Support/Orcquest/skills/lib/cdp.mjs · lines 76–84",
    ]);
  });

  it("does not take a write or an in-place edit for a read", () => {
    expect(read("cat > /tmp/palette-lab/final.mjs <<'EOF'\nconsole.log(1)\nEOF")).toEqual(["run Write final.mjs"]);
    expect(read(`sed -i '' 's/color: "#0B5A3C",/color: "#173F34",/' src/lib/catalog.ts`)).toEqual(["run Edit catalog.ts"]);
    expect(read("awk '/^### V3-/{item=$0}' .audit/v3-checklist.md")).toEqual(["raw awk '/^### V3-/{item=$0}' .audit/v3-checklist.md"]);
  });
});

describe("searches", () => {
  it("reads David's examples as what they looked for and where", () => {
    expect(read(`grep -n "TopBar\\|settings-sheet\\|className=\\"settings" views/Settings.tsx | head -20`)).toEqual([
      'search “TopBar”, “settings-sheet” or “className="settings” · in views/Settings.tsx',
    ]);
    expect(read(`grep -rn "settings-sheet" --include=*.css . 2>/dev/null | head`)).toEqual(["search “settings-sheet” · *.css"]);
  });

  it("counts matches only when nothing in the pipeline cuts or counts them", () => {
    expect(read(`grep -n "settling\\|reportedWork\\|releaseSettling" packages/agents/src/claude/adapter.ts`)).toEqual([
      "search “settling”, “reportedWork” or “releaseSettling” · in claude/adapter.ts · counts",
    ]);
    expect(read(`/bin/zsh -lc "rg -n 'onConflict\\\\(' packages/core/src/services/workspace-writers.ts"`)).toEqual(["search “onConflict(” · in services/workspace-writers.ts · counts"]);
    expect(read(`grep -rn "threads.move\\b\\|moveWorkspace" apps/desktop/src/renderer/src packages/core/src/openorc.ts | grep -v test`)).toEqual([
      "search “threads.move” or “moveWorkspace” · in renderer/src, src/openorc.ts · counts",
    ]);
    expect(read(`grep -n "private taskRunInput" -A 16 packages/core/src/services/thread-task-execution.ts`)).toEqual(["search “private taskRunInput” · in services/thread-task-execution.ts"]);
    expect(read("grep -c TODO a.ts")).toEqual(["search “TODO” · in a.ts"]);
    expect(read("rg -l useState src")).toEqual(["search “useState” · in src"]);
  });

  it("splits extended alternation for rg and grep -E, and keeps a long list short", () => {
    expect(read(`grep -n -E 'comments|queue' apps/desktop/src/renderer/src/lib/query.ts | head -20`)).toEqual(["search “comments” or “queue” · in lib/query.ts"]);
    expect(read(`rg -n 'ThreadStatus|agentQuiet' -g '*.ts' -g '*.tsx' -g '!**/node_modules/**'`)).toEqual(["search “ThreadStatus” or “agentQuiet” · *.ts, *.tsx · counts"]);
    expect(searchTerms("#173F34\\|#C8A77E\\|#F0EEE9\\|#424844", false)).toBe("“#173F34”, “#C8A77E”, “#F0EEE9” and 1 more");
    expect(searchTerms("^export function \\w+Label\\b", true)).toBe("“export function \\w+Label”");
    expect(searchTerms("a|b", false)).toBe("“a|b”");
    expect(searchTerms("(ai-client|bots.service|prompt)", true)).toBe("“ai-client”, “bots.service” or “prompt”");
    expect(searchTerms("(document|Document).*test", true)).toBe("“(document|Document)…test”");
    expect(searchTerms("^(PASS|FAIL)", true)).toBe("“PASS” or “FAIL”");
    expect(searchTerms("^  it(\\|^it(\\|^describe(", false)).toBe("“it(” or “describe(”");
  });

  it("reads a file piped into grep as a search in that file", () => {
    expect(read(`cat packages/core/package.json | grep -A8 '"scripts"'`)).toEqual(['search “"scripts"” · in core/package.json']);
    expect(read(`sed -n 1,28p src/mock-scenarios.ts | grep -n "import\\|toolDone"`)).toEqual(["search “import” or “toolDone” · in src/mock-scenarios.ts · counts"]);
  });

  it("leaves out where a variable points, past what it names", () => {
    expect(read(`grep -n "Held" $L/clone-verify-worker.log`)).toEqual(["search “Held” · in clone-verify-worker.log · counts"]);
    expect(read("cat $J")).toEqual(["raw cat $J"]);
    expect(read("ls -la $F")).toEqual(["raw ls -la $F"]);
  });

  it("finds git grep's paths after its double dash", () => {
    expect(read(`git grep -n "working directly in the repository" -- '*.ts' | head`)).toEqual(["search “working directly in the repository” · *.ts"]);
  });
});

describe("lists", () => {
  it("names the folder and any pattern it listed by", () => {
    expect(read("/bin/zsh -lc 'ls -la .audit/agent-2'")).toEqual(["list .audit/agent-2"]);
    expect(read(`ls node_modules/next/dist/docs/ 2>/dev/null | head; find node_modules/next/dist/docs -iname "*font*" | head`)).toEqual([
      "list node_modules/next/dist/docs",
      "list node_modules/next/dist/docs · *font*",
    ]);
    expect(read(`/bin/zsh -lc "rg --files apps/desktop/src/renderer/src | rg 'test' | head -120"`)).toEqual(["list apps/desktop/src/renderer/src · names with “test”"]);
    expect(read("ls")).toEqual(["list ."]);
    expect(read("tree -L 2 packages")).toEqual(["list packages"]);
  });
});

describe("chains", () => {
  it("gives each step its own action and skips the ones that only print or wait", () => {
    expect(read(`cat /Users/david/dev/why/portfoliov4/components/sidebar.tsx; echo ---; grep -rn "Sidebar" /Users/david/dev/why/portfoliov4/app --include=*.tsx | head`)).toEqual([
      "read /Users/david/dev/why/portfoliov4/components/sidebar.tsx",
      "search “Sidebar” · in portfoliov4/app, *.tsx",
    ]);
    expect(read("git diff HEAD -- apps/website/src/components/hero/TeamScene.astro | sed -n 60,80p; sed -n 80,96p apps/website/src/components/hero/TeamScene.astro")).toEqual([
      "run View the diff · TeamScene.astro",
      "read apps/website/src/components/hero/TeamScene.astro · lines 80–96",
    ]);
    expect(read("sleep 60; cat /private/tmp/claude-501/tasks/b1.output")).toEqual(["read /private/tmp/claude-501/tasks/b1.output"]);
    expect(read("set -e\nexport PATH=/x:$PATH\nJ=/tmp/j.jsonl; true")).toEqual([]);
  });

  it("reads a subshell and a captured step by what runs inside", () => {
    expect(read(`grep -n '"build"' apps/desktop/package.json && (pnpm --filter @immaculate/desktop build 2>&1 | tail -5)`)).toEqual([
      'search “"build"” · in desktop/package.json',
      "run Run the build · @immaculate/desktop",
    ]);
    expect(read(`n=$(grep -n "private addDirection" src/services/team-coordinator.ts | cut -d: -f1); sed -n "\${n},$((n+45))p" src/services/team-coordinator.ts | grep -n "teamRoom.append"`)).toEqual([
      "search “teamRoom.append” · in services/team-coordinator.ts · counts",
    ]);
  });

  it("keeps a loop or a block whole, as written", () => {
    expect(read(`for f in pages harden; do node --check $f.mjs; done`)).toEqual(["raw for f in pages harden; do node --check $f.mjs; done"]);
  });
});

describe("runs", () => {
  it("names checks plainly", () => {
    expect(read("npx tsc --noEmit && echo TSC-OK; npm run lint 2>&1 | tail -1; ps -Ao pid,ppid,command | grep '[G]oogle Chrome' | wc -l")).toEqual([
      "run Run the typecheck",
      "run Run lint",
      "raw ps -Ao pid,ppid,command | grep '[G]oogle Chrome' | wc -l",
    ]);
    expect(read("volta run --node 22.22.0 yarn typecheck 2>&1 | tail -3")).toEqual(["run Run the typecheck"]);
    expect(read("./.local-development/pnpm --filter @openorc/desktop test > /tmp/openorc-desktop-validation.log 2>&1")).toEqual(["run Run the tests · @openorc/desktop"]);
    expect(read(`../../.local-development/pnpm exec vitest run --project renderer src/renderer/src/lib/skill-commands.test.tsx -t "installed"`)).toEqual([
      "run Run the tests · skill-commands.test.tsx",
    ]);
    expect(read("cd /Users/david/dev/why/designate/packages/document && npx vitest run src/vector.test.ts 2>&1 | tail -40")).toEqual(["run Run the tests · vector.test.ts"]);
    expect(read("yarn next dev --turbopack -p 3000 > /tmp/sg-dev.log 2>&1")).toEqual(["run Start the dev server"]);
    expect(read("pnpm install")).toEqual(["run Install dependencies"]);
    expect(read("pnpm --filter @openorc/website add astro")).toEqual(["run Install astro"]);
  });

  it("names git by what it did", () => {
    expect(read("/bin/zsh -lc 'git status --short\n'")).toEqual(["run Check git status"]);
    expect(read("git log --oneline 9a6ebcc..HEAD | head -30")).toEqual(["run View git history"]);
    expect(read("cd /Users/david/dev/misc/sma/sma-3-monorepo && git show ad62f08:apps/mobile/src/utils/analytics.util.ts")).toEqual(["run View analytics.util.ts at ad62f08"]);
    expect(read("git show --stat a029ddd25")).toEqual(["run View commit a029ddd"]);
    expect(read("git diff --check")).toEqual(["run Check the diff for whitespace"]);
    expect(read("git ls-files -- ':(glob)**/.vscode/**'")).toEqual(["list . · **/.vscode/**"]);
    expect(read("pnpm licenses list --help")).toEqual(["raw pnpm licenses list --help"]);
    expect(read("git add apps/desktop/src/a.ts apps/desktop/src/b.ts")).toEqual(["run Stage a.ts and b.ts"]);
    expect(read(`git commit -m "feat(settings): card sections across settings" -m "Body"`)).toEqual(["run Commit “feat(settings): card sections across settings”"]);
    expect(read("git -C /tmp/repo checkout -b fix/rows")).toEqual(["run Create branch fix/rows"]);
    expect(read("git clone --depth 1 https://github.com/pingdotgg/t3code.git /tmp/t3code")).toEqual(["run Clone t3code"]);
  });

  it("names scripts by their file, and inline scripts by their language", () => {
    expect(read("timeout 180 node_modules/.bin/tsx bench/showcase/run.mts --check 2>&1 | tail -20")).toEqual(["run Run run.mts"]);
    expect(read("/bin/zsh -lc 'python3 .audit/main-review-3/commits/check-isolated-http.py'")).toEqual(["run Run check-isolated-http.py"]);
    expect(read("python3 - <<'EOF'\np='app/blog/page.tsx'\nprint(p)\nEOF")).toEqual(["run Run a Python script · page.tsx"]);
    expect(read(`node --input-type=module <<'JS'\nconsole.log(1)\nJS`)).toEqual(["run Run a Node script"]);
    expect(read(`python3 -I -c "import json; print(1)"`)).toEqual(["run Run a Python script"]);
    expect(read("chmod +x .audit/tools/simulate/stack.sh && .audit/tools/simulate/stack.sh up 2>&1 | tail -20")).toEqual(["run Change permissions of stack.sh", "run Run stack.sh"]);
  });

  it("names files, processes, pages and databases it touched", () => {
    expect(read(`/bin/zsh -lc "curl --max-time 20 --silent --head --header 'Origin: https://dev3.socmedaccelerator.com' https://api-production-089b.up.railway.app/ping"`)).toEqual([
      "run Fetch api-production-089b.up.railway.app",
    ]);
    expect(read("mkdir -p branding/round-3/g1-white branding/round-3/g2-stone")).toEqual(["run Create g1-white and g2-stone"]);
    expect(read("rm -f public/media/before-kitchen.jpg")).toEqual(["run Delete before-kitchen.jpg"]);
    expect(read("mv bench/showcase .local-development/bench")).toEqual(["run Move showcase"]);
    expect(read("cp yarn.lock /tmp/agent3-v306/yarn.lock.before")).toEqual(["run Copy yarn.lock"]);
    expect(read("kill 8251")).toEqual(["run Stop a process"]);
    expect(read("pkill -f electron-vite")).toEqual(["run Stop electron-vite"]);
    expect(read("open http://127.0.0.1:5177/?view=working")).toEqual(["run Open 127.0.0.1:5177"]);
    expect(read(`sqlite3 /tmp/openorc-editor-qa/profile/openorc.sqlite "select 1"`)).toEqual(["run Query openorc.sqlite"]);
    expect(read(`echo "select count(*) from runs;" | sqlite3 -readonly ledger.db`)).toEqual(["run Query ledger.db"]);
    expect(read(`psql -h 127.0.0.1 -p 15432 -U sma sma_local -c "\\d harness_turns"`)).toEqual(["run Query sma_local"]);
  });

  it("leaves anything else as its first line", () => {
    expect(read("cd /tmp && opencode serve --help")).toEqual(["raw opencode serve --help"]);
  });
});

describe("what a grep printed", () => {
  it("reads a file filtered through grep -v, and counts nothing it inverted", () => {
    expect(read(`grep -v "^$" /tmp/openorc-qa/app.log | tail -4`)).toEqual(["read /tmp/openorc-qa/app.log · last 4 lines"]);
    expect(read("grep -v '^#' .env")).toEqual(["read .env"]);
    expect(read(`cat build.log | grep -v "warning"`)).toEqual(["read build.log"]);
    expect(read("rg -v foo -g '*.ts'")).toEqual(["search “foo” · *.ts"]);
  });

  it("counts lines for an empty pattern instead of searching for nothing", () => {
    expect(read(`grep -c "" packages/mcp/src/index.ts`)).toEqual(["run Count lines in index.ts"]);
    expect(read(`grep -n "" "$f" | sed -n 1,80p`)).toEqual([`raw grep -n "" "$f" | sed -n 1,80p`]);
  });

  it("does not count a search capped by -m or --max-count", () => {
    expect(read("grep -m 3 foo f.ts")).toEqual(["search “foo” · in f.ts"]);
    expect(read("rg -m1 foo src")).toEqual(["search “foo” · in src"]);
    expect(read("rg --max-count 1 foo src")).toEqual(["search “foo” · in src"]);
  });

  it("counts a search only when it is the one step that printed", () => {
    expect(read(`grep -n "—" a.md b.md; echo "em-dash hits: $?"`)).toEqual(["search “—” · in a.md, b.md"]);
    expect(read(`test -d .codegraph && echo indexed; rg -n 'foo' src`)).toEqual(["search “foo” · in src"]);
    expect(read(`cd apps/desktop && rg -n 'foo' src`)).toEqual(["search “foo” · in src · counts"]);
  });

  it("joins every -e pattern as alternatives", () => {
    expect(read("grep -e foo -e bar f")).toEqual(["search “foo” or “bar” · in f · counts"]);
  });

  it("keeps a term that is still a regex as written", () => {
    expect(searchTerms("\\[data-[a-z-]+(=[^]]+)?\\]", true)).toBe("“\\[data-[a-z-]+(=[^]]+)?\\]”");
    expect(searchTerms(".\\{240\\}\\.project", false)).toBe("“.\\{240\\}\\.project”");
    expect(searchTerms("onConflict\\(", true)).toBe("“onConflict(”");
  });
});

describe("listings piped on", () => {
  it("keeps the names a grep let through", () => {
    expect(read(`ls packages/core/src/services/ | grep -i "system\\|harness\\|launch"`)).toEqual(["list packages/core/src/services · names with “system”, “harness” or “launch”"]);
    expect(read("git ls-files | grep -i orc")).toEqual(["list . · names with “orc”"]);
  });

  it("reads files handed to grep by xargs as a search in them", () => {
    expect(read(`cd ~/.claude/projects && find . -name "*.jsonl" -newermt 2026-08-01 | xargs grep -l 'ExitPlanMode'`)).toEqual(["search “ExitPlanMode” · in .claude/projects, *.jsonl"]);
  });

  it("checks files rather than listing folders when ls names files", () => {
    expect(read("ls apps/desktop/src/renderer/src/views/Onboarding.tsx apps/desktop/src/renderer/src/components/HarnessScan.tsx")).toEqual(["run Check Onboarding.tsx and HarnessScan.tsx"]);
    expect(read("ls -d */")).toEqual(["list . · */"]);
    expect(read("ls src/*.ts")).toEqual(["list src · *.ts"]);
  });
});

describe("paths", () => {
  it("keeps a cd inside a subshell there", () => {
    expect(read("(cd apps/mobile && npx prettier --check a.ts); sed -n 11p apps/api/POSTGRES_MIGRATION.md")).toEqual(["run Check formatting", "read apps/api/POSTGRES_MIGRATION.md · line 11"]);
  });

  it("resolves . and .. steps", () => {
    expect(read("cd apps && cd .. && cat README.md")).toEqual(["read README.md"]);
    expect(read("cd apps/desktop/src && cd ../.. && sed -n 1,20p package.json")).toEqual(["read apps/package.json · lines 1–20"]);
  });

  it("reads each file a brace names", () => {
    expect(read("head -n 5 src/{a,b}.ts")).toEqual(["read src/a.ts · first 5 lines", "read src/b.ts · first 5 lines"]);
  });

  it("runs what an assignment captured", () => {
    expect(read(`out=$(npx jest a.spec.ts 2>&1); echo "$out" | grep -E "^Tests:|✕"`)).toEqual(["run Run the tests · a.spec.ts", "search “Tests:” or “✕”"]);
  });
});

describe("run labels", () => {
  it("names git by what each subcommand does", () => {
    expect(read("git stash list")).toEqual(["run List stashes"]);
    expect(read("git stash show -p stash@{0}")).toEqual(["run View a stash"]);
    expect(read("git stash drop")).toEqual(["run Delete a stash"]);
    expect(read("git stash")).toEqual(["run Stash changes"]);
    expect(read("git branch --list 'feat*'")).toEqual(["run List branches"]);
    expect(read("git branch --contains abc1234")).toEqual(["run List branches"]);
    expect(read("git branch -m old new")).toEqual(["run Rename branch old to new"]);
    expect(read("git branch fix/rows")).toEqual(["run Create branch fix/rows"]);
    expect(read("git show --stat HEAD~3")).toEqual(["run View commit HEAD~3"]);
    expect(read("git show")).toEqual(["run View the last commit"]);
    expect(read("git rm --cached file.txt")).toEqual(["run Untrack file.txt"]);
  });

  it("finds a commit's subject in a heredoc", () => {
    expect(read(`git commit -m "$(cat <<'EOF'\nfeat: add thing\n\nbody\nEOF\n)"`)).toEqual(["run Commit “feat: add thing”"]);
    expect(read("git commit -F - <<'EOF'\nfix(rows): keep the gap\n\nBody\nEOF")).toEqual(["run Commit “fix(rows): keep the gap”"]);
  });

  it("skips a package manager's options before the script and the packages", () => {
    expect(read("npm run -s typecheck")).toEqual(["run Run the typecheck"]);
    expect(read("npm run --silent build")).toEqual(["run Run the build"]);
    expect(read("pnpm --store-dir .pnpm-store --filter @orcquest/core add @slack/socket-mode @slack/web-api")).toEqual(["run Install @slack/socket-mode, @slack/web-api"]);
    expect(read("pnpm install --filter @orcquest/website --store-dir .pnpm-store")).toEqual(["run Install dependencies · @orcquest/website"]);
  });

  it("names scripts, tests, processes and databases plainly", () => {
    expect(read(`python3 - "$v313_pgdir" <<'PY'\nprint(1)\nPY`)).toEqual(["run Run a Python script"]);
    expect(read("python3 -m pytest tests/test_a.py")).toEqual(["run Run the tests · test_a.py"]);
    expect(read("node --test scripts/*.test.cjs")).toEqual(["run Run the tests · *.test.cjs"]);
    expect(read(`pkill -f ".../Contents/MacOS/Electron /tmp/orcquest-native-hit/calibrate.cjs"`)).toEqual(["run Stop calibrate.cjs"]);
    expect(read("pkill -f 'electron .*'")).toEqual(["run Stop a process"]);
    expect(read(`sqlite3 'file:/Users/d/Library/Application Support/Orcquest/openorc.sqlite?mode=ro&immutable=1' -readonly 'select 1'`)).toEqual(["run Query openorc.sqlite"]);
    expect(read("open -a Safari http://localhost:3000")).toEqual(["run Open localhost:3000"]);
    expect(read("rm -rf node_modules dist")).toEqual(["run Delete node_modules and dist"]);
  });

  it("tells inline scripts apart by the file they name or a module they import", () => {
    expect(read(`python3 - <<'PY'\nimport json, sqlite3\ncon = sqlite3.connect("/tmp/ledger.db")\nPY`)).toEqual(["run Run a Python script · ledger.db"]);
    expect(read(`node -e "const { chromium } = require('playwright')"`)).toEqual(["run Run a Node script · playwright"]);
  });
});

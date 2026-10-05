import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Block } from "../lib/transcript";
import { ToolDetail } from "./ToolDetail";

vi.mock("./ThreadImages", () => ({
  ThreadRichText: ({ children, lineNumbers }: { children: string; lineNumbers?: boolean }) => (
    <pre data-testid="rich" data-line-numbers={String(Boolean(lineNumbers))}>
      {children}
    </pre>
  ),
  ThreadLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a data-href={href}>{children}</a>,
  ThreadImage: () => null,
}));
afterEach(cleanup);

const call = (name: string, input: unknown, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Extract<Block, { kind: "tool" }> => ({ id: "t", kind: "tool", name, input, done: true, ...extra });

it("shows a command as a command and a printed file as numbered, highlighted code", () => {
  const { container } = render(
    <ToolDetail
      block={call("Bash", { command: "cd /repo/apps/desktop/src && sed -n 60,61p components/Transcript.tsx", description: "Read it" })}
      output={"  run: RunTranscript;\n  scrollKey?: string;"}
    />,
  );
  expect(container.querySelector(".tool-view-command code")?.textContent).toBe("$sed -n 60,61p components/Transcript.tsx");
  expect(screen.getByTitle("/repo/apps/desktop/src").textContent).toBe("…/desktop/src");
  const code = screen.getByTestId("rich");
  expect(code.textContent).toBe("```tsx startLine=60\n  run: RunTranscript;\n  scrollKey?: string;\n```");
  expect(code.dataset.lineNumbers).toBe("true");
  expect(screen.queryByText(/"command"/)).toBeNull();
});

it("tallies a test run and opens the output only when something failed", () => {
  const output = " FAIL  src/a.test.ts\n      Tests  2 failed | 1015 passed (1017)";
  render(<ToolDetail block={call("Bash", { command: "pnpm test" }, { isError: true })} output={output} />);
  expect(screen.getByText("2 failed")).toBeTruthy();
  expect(screen.getByText("1015 passed")).toBeTruthy();
  expect(screen.getByText(/FAIL\s+src\/a.test.ts/)).toBeTruthy();
  cleanup();
  render(<ToolDetail block={call("Bash", { command: "pnpm test" })} output={"      Tests  48 passed (48)"} />);
  expect(screen.queryByText(/Tests\s+48 passed/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Output" }));
  expect(screen.getByText(/Tests\s+48 passed/)).toBeTruthy();
});

it("groups search matches by file with the pattern marked, and opens each where it matched", () => {
  const { container } = render(<ToolDetail block={call("Bash", { command: "cd /repo && rg -n agentQuiet src" })} output={"src/a.ts:3:const q = agentQuiet();\nsrc/b.ts:1:import { agentQuiet }"} />);
  expect([...container.querySelectorAll("a[data-href]")].map((link) => link.getAttribute("data-href"))).toEqual(["/repo/src/a.ts", "/repo/src/a.ts:3", "/repo/src/b.ts", "/repo/src/b.ts:1"]);
  expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["agentQuiet", "agentQuiet"]);
  expect(container.querySelectorAll(".tool-view-line")[0]?.textContent).toBe("3");
});

it("shows each step at its prompt with the script it feeds in highlighted below", () => {
  const command = "cd /repo && # check the ledger\npython3 - <<'PY'\nimport sqlite3\nprint(1)\nPY";
  const { container } = render(<ToolDetail block={call("Bash", { command })} output="1" />);
  expect([...container.querySelectorAll(".tool-view-step > code")].map((line) => line.textContent)).toEqual(["# check the ledger", "$python3 -"]);
  expect(container.querySelector(".tool-view-step > code[data-comment]")?.textContent).toBe("# check the ledger");
  expect(container.querySelector("[data-script] [data-testid=rich]")?.textContent).toBe("```py\nimport sqlite3\nprint(1)\n```");
});

it("reads git status as files with what happened to each, leaving deleted ones unlinked", () => {
  const { container } = render(<ToolDetail block={call("shell", { command: "git status --short", cwd: "/repo" })} output={" M src/a.ts\n D old.ts\n?? notes/"} />);
  expect([...container.querySelectorAll("[data-status]")].map((status) => status.textContent)).toEqual(["Modified", "Deleted", "New"]);
  expect([...container.querySelectorAll("a[data-href]")].map((link) => link.getAttribute("data-href"))).toEqual(["/repo/src/a.ts", "/repo/notes/"]);
});

it("shows an MCP call's arguments as fields, and the raw call on request", () => {
  render(<ToolDetail block={call("mcp__claude_ai_Mobbin__search_screens", { query: "onboarding", limit: 8 })} output={{ content: [{ type: "text", text: "Found 8 screens" }] }} />);
  expect(screen.getByText("query").nextSibling?.textContent).toBe("onboarding");
  expect(screen.getByText("Found 8 screens")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Raw call" }));
  expect(screen.getByText(/"query": "onboarding"/)).toBeTruthy();
});

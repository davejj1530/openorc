import { createRoot } from "react-dom/client";
import type { Block } from "../../packages/client/src";
import { ApprovalCard } from "../../apps/desktop/src/renderer/src/components/ApprovalCard";

/** A 15-line command whose last line is the one that matters. */
const heredoc = ["cat > release-notes.md <<'EOF'", ...Array.from({ length: 12 }, (_, i) => `- Note ${i + 1}: changed part ${i + 1}`), "EOF", "git push --force origin main"].join("\n");
/** A 30-line script, too long to show whole, that ends in the line that matters. */
const script = [...Array.from({ length: 29 }, (_, i) => `echo line-${i + 1} of the release checklist`), "git push --force origin main"].join("\n");

/** The request the page shows, named by its query: a shell command, a long script, or an MCP call with a long list. */
const inputs: Record<string, unknown> = {
  heredoc: { command: heredoc, description: "Write the notes and push them" },
  script: { command: script, description: "Run the checklist and push" },
  ids: { _meta: { tool_params: { ids: Array.from({ length: 120 }, (_, i) => 1000 + i) } } },
};
const input = inputs[new URLSearchParams(location.search).get("request") ?? "heredoc"];
const block = {
  id: "approval",
  kind: "approval",
  approvalId: "approval",
  approvalKind: "command",
  toolName: "Bash",
  input,
  reason: null,
  decision: null,
  onceOnly: false,
} as unknown as Extract<Block, { kind: "approval" }>;

createRoot(document.getElementById("root")!).render(
  <div className="app-shell bg-bg text-ink" style={{ height: "100vh" }}>
    <div data-transcript>
      <div className="max-w-chat">
        <ApprovalCard block={block} runId="run" />
      </div>
    </div>
  </div>,
);

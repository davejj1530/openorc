import { Check, FileText, Globe, Hammer, Search, WorkCommand, WorkDelegate, WorkEdit, WorkMessage, WorkRead, WorkSearch } from "./icons";

export type ToolIcon = typeof WorkCommand;

/** The hue a step's icon takes from what kind of work it is. */
export type Tone = "read" | "edit" | "run" | "search" | "web" | "task" | "memory" | "plan" | "think" | "context" | "neutral";

function editedObject(paths: string[]): string {
  if (paths.length === 1) return paths[0]!;
  if (paths.length) return `${paths.length} files`;
  return "";
}

/** Verb and object for a tool call, from the names Claude Code and Codex use. */
export function toolCallPresentation(name: string, input: unknown): { icon: ToolIcon; verb: string; object: string; tone: Tone; summary?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const mcp = mcpCall(name);
  const n = mcp?.tool ?? name;
  const command = str("cmd") || str("command") || (Array.isArray(i["command"]) ? (i["command"] as string[]).join(" ") : "");
  if (/^(shell|bash|exec|exec_command|run_command|execute)$/i.test(n) || command)
    return { icon: WorkCommand, verb: "Ran", object: command.replace(/^\/bin\/zsh -lc /, "").replace(/^'(.*)'$/, "$1"), tone: "run" };
  if (/^(read|read_file|view|cat|notebookread)$/i.test(n)) return { icon: WorkRead, verb: "Read", object: str("file_path") || str("path"), tone: "read" };
  if (/^(edit|multiedit|write|apply_patch|write_file|str_replace|create_file|notebookedit)$/i.test(n)) {
    if (Array.isArray(input)) {
      const paths = input.flatMap((entry) => (entry && typeof entry.path === "string" ? [entry.path] : []));
      return { icon: WorkEdit, verb: "Edited", object: editedObject(paths), tone: "edit" };
    }
    const patch = str("patch") || str("input");
    const files = patch ? patch.split("\n").filter((l) => /^\*\*\* (Add|Update|Delete) File: /.test(l)).length : 0;
    return { icon: WorkEdit, verb: "Edited", object: str("file_path") || str("path") || (files ? `${files} file${files === 1 ? "" : "s"}` : ""), tone: "edit" };
  }
  if (/^(grep|glob|search|rg|find|ls)$/i.test(n)) return { icon: WorkSearch, verb: "Searched", object: str("pattern") || str("query") || str("path"), tone: "search" };
  if (/^(webfetch|fetch)$/i.test(n)) return { icon: Globe, verb: "Fetched", object: str("url"), tone: "web" };
  if (/^websearch$/i.test(n)) return { icon: Globe, verb: "Searched the web for", object: str("query"), tone: "web" };
  if (/thread_send$|send_message$|team_say$/.test(n)) return { icon: WorkMessage, verb: "Sent message", object: str("target") || str("recipient") || "", tone: "neutral" };
  if (/task_start$/.test(n)) return { icon: WorkDelegate, verb: "Started task", object: str("title") || str("id"), tone: "task" };
  if (/spawn_agent$/.test(n)) return { icon: WorkDelegate, verb: "Delegated", object: str("title") || str("task_name"), tone: "task" };
  if (/task_create$/.test(n)) return { icon: WorkDelegate, verb: "Created task", object: str("title"), tone: "task" };
  if (/task_list$/.test(n)) return { icon: WorkDelegate, verb: "Listed tasks", object: "", tone: "task" };
  if (/task_get$/.test(n)) return { icon: WorkDelegate, verb: "Checked task", object: str("id").slice(0, 8), tone: "task" };
  if (/task_update$/.test(n)) return { icon: WorkDelegate, verb: "Updated task", object: str("id").slice(0, 8), tone: "task" };
  if (/memory_search$/.test(n)) return { icon: Search, verb: "Searched memory for", object: str("query"), tone: "memory" };
  if (/memory_record$/.test(n)) return { icon: WorkRead, verb: "Remembered", object: str("title"), tone: "memory" };
  if (/memory_feedback$/.test(n)) return { icon: WorkRead, verb: "Rated a memory", object: "", tone: "memory" };
  if (/task_context$/.test(n)) return { icon: FileText, verb: "Read the task brief", object: "", tone: "task" };
  if (/^(task|agent|subagent)$/i.test(n)) return { icon: WorkDelegate, verb: "Delegated", object: str("description"), tone: "task" };
  if (/^todowrite$/i.test(n)) return { icon: Check, verb: "Updated the plan", object: "", tone: "plan" };
  const object = str("description") || str("query") || str("path");
  if (mcp) {
    const { label, source } = mcpNames(mcp);
    return { icon: Hammer, verb: label, object, tone: "neutral", summary: `Used ${source}` };
  }
  return { icon: Hammer, verb: n, object, tone: "neutral" };
}

type McpCall = { server: string; tool: string };

/**
 * An MCP tool call in each provider's naming: Claude Code's `mcp__server__tool`, Codex's `server.tool`, and OpenCode's
 * `server_tool`, which only splits reliably for OpenOrc's own `openorc_<id>` server.
 */
function mcpCall(name: string): McpCall | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^([^.]+)\.(.+)$/.exec(name) ?? /^(openorc_[0-9a-f]{32})_(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

/** "Codegraph: explore" for codegraph's `codegraph_explore`: the server as configured, minus Claude's claude.ai connector prefix, and the tool without a repeated server name. */
function mcpNames({ server, tool }: McpCall): { label: string; source: string } {
  const base = /^openorc(?:_[0-9a-f]{32})?$/.test(server) ? "OpenOrc" : server.replace(/^claude_ai_/, "");
  const action = tool.toLowerCase().startsWith(`${base.toLowerCase()}_`) ? tool.slice(base.length + 1) : tool;
  const spaced = (s: string) => s.replace(/[_-]+/g, " ").trim();
  const source = spaced(base).replace(/^./, (c) => c.toUpperCase());
  return { label: `${source}: ${spaced(action)}`, source };
}

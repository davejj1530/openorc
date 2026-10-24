import { isVisualizationTool } from "@openorc/protocol";

/** The icon a tool call shows, by name; each app draws the names with its own icon set. */
export type ToolIconName = "Check" | "FileText" | "Globe" | "Hammer" | "Search" | "WorkCommand" | "WorkDelegate" | "WorkEdit" | "WorkMessage" | "WorkRead" | "WorkSearch";

/** The hue a step's icon takes from what kind of work it is. */
export type Tone = "read" | "edit" | "run" | "search" | "web" | "task" | "memory" | "plan" | "think" | "context" | "neutral";

function editedObject(input: unknown, filePath: string, patch: string): string {
  if (Array.isArray(input)) {
    const paths = input.flatMap((entry) => (entry && typeof entry.path === "string" ? [entry.path] : []));
    if (paths.length === 1) return paths[0]!;
    return paths.length ? `${paths.length} files` : "";
  }
  if (filePath) return filePath;
  const files = patch ? patch.split("\n").filter((line) => /^\*\*\* (Add|Update|Delete) File: /.test(line)).length : 0;
  return files ? `${files} file${files === 1 ? "" : "s"}` : "";
}

type ToolPresentation = { icon: ToolIconName; verb: string; object: string; tone: Tone; summary?: string };

/** Tools by the names Claude Code, Codex and OpenOrc's own server give them, tried in order. */
const namedTools: [RegExp, (str: (key: string) => string, input: unknown) => ToolPresentation][] = [
  [/^(read|read_file|view|cat|notebookread)$/i, (str) => ({ icon: "WorkRead", verb: "Read", object: str("file_path") || str("path"), tone: "read" })],
  [
    /^(edit|multiedit|write|apply_patch|write_file|str_replace|create_file|notebookedit)$/i,
    (str, input) => ({ icon: "WorkEdit", verb: "Edited", object: editedObject(input, str("file_path") || str("path"), str("patch") || str("input")), tone: "edit" }),
  ],
  [/^(grep|glob|search|rg|find|ls)$/i, (str) => ({ icon: "WorkSearch", verb: "Searched", object: str("pattern") || str("query") || str("path"), tone: "search" })],
  [/^(webfetch|fetch)$/i, (str) => ({ icon: "Globe", verb: "Fetched", object: str("url"), tone: "web" })],
  [/^websearch$/i, (str) => ({ icon: "Globe", verb: "Searched the web for", object: str("query"), tone: "web" })],
  [/thread_send$|send_message$|team_say$/, (str) => ({ icon: "WorkMessage", verb: "Sent message", object: str("target") || str("recipient") || "", tone: "neutral" })],
  [/task_start$/, (str) => ({ icon: "WorkDelegate", verb: "Started task", object: str("title") || str("id"), tone: "task" })],
  [/spawn_agent$/, (str) => ({ icon: "WorkDelegate", verb: "Delegated", object: str("title") || str("task_name"), tone: "task" })],
  [/task_create$/, (str) => ({ icon: "WorkDelegate", verb: "Created task", object: str("title"), tone: "task" })],
  [/task_list$/, () => ({ icon: "WorkDelegate", verb: "Listed tasks", object: "", tone: "task" })],
  [/task_get$/, (str) => ({ icon: "WorkDelegate", verb: "Checked task", object: str("id").slice(0, 8), tone: "task" })],
  [/task_update$/, (str) => ({ icon: "WorkDelegate", verb: "Updated task", object: str("id").slice(0, 8), tone: "task" })],
  [/memory_search$/, (str) => ({ icon: "Search", verb: "Searched memory for", object: str("query"), tone: "memory" })],
  [/memory_record$/, (str) => ({ icon: "WorkRead", verb: "Remembered", object: str("title"), tone: "memory" })],
  [/memory_feedback$/, () => ({ icon: "WorkRead", verb: "Rated a memory", object: "", tone: "memory" })],
  [/task_context$/, () => ({ icon: "FileText", verb: "Read the task brief", object: "", tone: "task" })],
  [/^(task|agent|subagent)$/i, (str) => ({ icon: "WorkDelegate", verb: "Delegated", object: str("description"), tone: "task" })],
  [/^todowrite$/i, () => ({ icon: "Check", verb: "Updated the plan", object: "", tone: "plan" })],
];

/** Verb and object for a tool call, from the names Claude Code and Codex use. */
export function toolCallPresentation(name: string, input: unknown): ToolPresentation {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (isVisualizationTool(name)) return { icon: "FileText", verb: "Visualized", object: str("title"), tone: "read" };
  const mcp = mcpCall(name);
  const n = mcp?.tool ?? name;
  const command = str("cmd") || str("command") || (Array.isArray(i["command"]) ? (i["command"] as string[]).join(" ") : "");
  if (/^(shell|bash|exec|exec_command|run_command|execute)$/i.test(n) || command)
    return { icon: "WorkCommand", verb: "Ran", object: command.replace(/^\/bin\/zsh -lc /, "").replace(/^'(.*)'$/, "$1"), tone: "run" };
  const named = namedTools.find(([pattern]) => pattern.test(n));
  if (named) return named[1](str, input);
  const object = str("description") || str("query") || str("path");
  if (mcp) {
    const { label, source } = mcpNames(mcp);
    return { icon: "Hammer", verb: label, object, tone: "neutral", summary: `Used ${source}` };
  }
  return { icon: "Hammer", verb: n, object, tone: "neutral" };
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

/** What a call is doing while it runs: "Running command" for "Ran". */
export function liveVerb(verb: string): string {
  const live: Record<string, string> = {
    Ran: "Running command",
    Read: "Reading files",
    Edited: "Editing files",
    Searched: "Searching",
    Fetched: "Fetching",
    Delegated: "Delegating",
    "Sent message": "Sending message",
  };
  return live[verb] ?? verb;
}

/** How a call or activity ended, in a word. */
export function stateLabel(status: string): string {
  return ({ success: "Completed", error: "Failed", cancelled: "Interrupted", disconnected: "Disconnected", running: "Running" } as Record<string, string>)[status] ?? status;
}

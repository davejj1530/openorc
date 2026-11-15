import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskStatus } from "@openorc/protocol";
import { z } from "zod";
import type { McpHost } from "./index.js";
import { TaskScope } from "./task-types.js";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();

/** A run the host lets reach online tasks may also name the task's place, and a change the revision it read. */
function online<T extends z.ZodRawShape, O extends z.ZodRawShape>(on: boolean, shape: T, extra: O): T & Partial<O> {
  const added: Partial<O> = on ? extra : {};
  return { ...shape, ...added };
}

export function registerTaskContext(mcp: McpServer, host: McpHost, runId: string) {
  mcp.registerTool(
    "task_context",
    {
      description: "The brief for the current task: spec, prior attempts, related decisions and lessons, commands that worked.",
      inputSchema: online(host.onlineTasks?.(runId) === true, {}, { scope: TaskScope.optional(), taskId: z.string().min(1).optional() }),
    },
    async (options) => ({ content: [{ type: "text", text: await host.taskContext(runId, options) }] }),
  );
}

export function registerTaskTools(mcp: McpServer, host: McpHost, runId: string) {
  const on = host.onlineTasks?.(runId) === true;
  registerCreate(mcp, host, runId, on);
  registerStart(mcp, host, runId, on);
  registerList(mcp, host, runId, on);
  registerGet(mcp, host, runId, on);
  registerUpdate(mcp, host, runId, on);
}

function registerCreate(mcp: McpServer, host: McpHost, runId: string, on: boolean) {
  mcp.registerTool(
    "task_create",
    {
      description:
        "Create a polished task document directly in OpenOrc, only when the user explicitly asks for a task. A task is work the user asked to have saved or built. Never create one on your own initiative, for follow-ups, ideas, or issues you notice; mention those in your reply instead. Conversation is not a task: greetings, questions, opinions, status and coordination are answered in your reply never captured or delegated as tasks. Defaults to backlog: no agent starts and no worktree is created, even in Act mode. 'Create a task' or 'add to backlog' requests capture, not implementation: save with execution=backlog and confirm. Act permits the requested action; it never overrides the user's intent. For ordinary tasks, creation only saves the document, including legacy execution=delegate requests. When asked to implement, call task_start and do the work in this same conversation; never forward it to a separate task agent. Use MCP directly, not Computer Use, browser automation, or database writes. Call task_list first to avoid duplicates. Only threads can create tasks.",
      inputSchema: online(
        on,
        {
          title: z.string().min(3).max(120).describe("Imperative, specific, unique within the thread"),
          spec: z
            .string()
            .min(10)
            .describe(
              "Well-written Markdown document: Goal, Scope, Acceptance criteria (checklist), and Verification. Include relevant constraints and concrete outcomes; omit empty sections and do not invent requirements.",
            ),
          priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
          labels: z.array(z.string().min(1).max(60)).max(20).optional(),
          execution: z.enum(["backlog", "delegate"]).default("backlog").describe("Saves the task without starting an agent. Legacy delegate requests also save only."),
          workspace_mode: z
            .enum(["current", "worktree"])
            .optional()
            .describe(
              "Current uses the existing checkout and branch, worktree creates an isolated workspace. Omit to save the user’s default. Exclusive workspace operations can block local startup; never silently fall back to a worktree.",
            ),
        },
        { scope: TaskScope.optional() },
      ),
    },
    async ({ title, spec, priority, labels, execution, workspace_mode, scope }) => {
      const result = await host.tasks.create(runId, {
        title,
        ...(scope ? { scope } : {}),
        spec,
        execution,
        ...(workspace_mode !== undefined ? { workspaceMode: workspace_mode } : {}),
        ...(priority ? { priority } : {}),
        ...(labels ? { labels } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}

function registerStart(mcp: McpServer, host: McpHost, runId: string, on: boolean) {
  mcp.registerTool(
    "task_start",
    {
      description:
        "Mark an existing ordinary task in progress and implement it yourself in the current conversation and workspace. This does not launch or forward to another agent. Requires Act mode. Reuse the task ID. Creating a backlog task does not require starting it.",
      inputSchema: online(
        on,
        {
          id: z.string().min(1),
          workspace_mode: z.enum(["current", "worktree"]).optional().describe("Tasks run in the current conversation workspace. Omit this field; a different location requires moving the thread."),
        },
        { scope: TaskScope.optional(), ifRevision: revision },
      ),
    },
    async ({ id, workspace_mode, scope, ifRevision }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await host.tasks.start(runId, id, {
              ...(scope ? { scope } : {}),
              ...(ifRevision !== undefined ? { ifRevision } : {}),
              ...(workspace_mode !== undefined ? { workspaceMode: workspace_mode } : {}),
            }),
          ),
        },
      ],
    }),
  );
}

function registerList(mcp: McpServer, host: McpHost, runId: string, on: boolean) {
  mcp.registerTool(
    "task_list",
    {
      description: "Tasks across all threads in this project with their status and branch. The task you are executing, if any, is marked current.",
      inputSchema: online(on, {}, { scope: TaskScope.optional() }),
    },
    async ({ scope }) => ({ content: [{ type: "text", text: JSON.stringify(await host.tasks.list(runId, scope)) }] }),
  );
}

function registerGet(mcp: McpServer, host: McpHost, runId: string, on: boolean) {
  mcp.registerTool(
    "task_get",
    {
      description:
        "Read any task in this project by ID, regardless of its originating thread. Live progress includes: latest agent commentary, current action, permission/input wait, run outcome, and result summary. Use this when the user asks for a report; waiting means paused, not still implementing.",
      inputSchema: online(on, { id: z.string() }, { scope: TaskScope.optional() }),
    },
    async ({ id, scope }) => ({ content: [{ type: "text", text: JSON.stringify(await host.tasks.get(runId, id, scope)) }] }),
  );
}

function registerUpdate(mcp: McpServer, host: McpHost, runId: string, on: boolean) {
  mcp.registerTool(
    "task_update",
    {
      description:
        "Update any task in this project by ID, regardless of its originating thread or assigned agent. Set its board status or refine its spec. A status move does not stop an execution or change its recorded outcome.",
      inputSchema: online(on, { id: z.string(), status: TaskStatus.optional(), spec: z.string().optional() }, { scope: TaskScope.optional(), ifRevision: revision }),
    },
    async ({ id, status, spec, scope, ifRevision }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await host.tasks.update(runId, id, { ...(scope ? { scope } : {}), ...(ifRevision !== undefined ? { ifRevision } : {}), ...(status ? { status } : {}), ...(spec ? { spec } : {}) }),
          ),
        },
      ],
    }),
  );
}

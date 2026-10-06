import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface OrclingMemoryEntry {
  type: string;
  title: string;
  body: string;
  topicKey?: string;
}

/**
 * What an Orcling can do wherever it works: keep its own instructions and
 * memory, search what it said before, and find the user's projects to read
 * their memory, tasks and threads or hand them work. Each call answers in
 * text the model reads directly.
 */
export interface OrclingTools {
  /** Whether the run speaks as an Orcling. */
  available(runId: string): boolean;
  /** Whether the run is the Orcling's own conversation: a chat, where these tools stand in for the general task, thread and memory tools. */
  ownConversation(runId: string): boolean;
  updateInstructions(runId: string, input: { body: string; reason: string }): Promise<string>;
  remember(runId: string, entry: OrclingMemoryEntry): Promise<string>;
  recall(runId: string, query: string, limit: number): Promise<string>;
  history(runId: string, query: string, limit: number): Promise<string>;
  projects(runId: string): Promise<string>;
  project(runId: string, projectId: string, query: string | undefined): Promise<string>;
  readThread(runId: string, threadId: string, limit: number): Promise<string>;
  createTask(runId: string, input: { projectId: string; title: string; spec: string }): Promise<string>;
  startWork(runId: string, input: { projectId: string; prompt: string; taskId?: string; title?: string }): Promise<string>;
  sendThread(runId: string, input: { threadId: string; text: string; requestKey?: string }): Promise<string>;
}

/** Every Orcling tool, so providers treat them as OpenOrc's own. */
export const orclingToolNames = [
  "orcling_instructions_update",
  "orcling_remember",
  "orcling_recall",
  "orcling_history",
  "orcling_projects",
  "orcling_project",
  "orcling_thread_read",
  "orcling_task_create",
  "orcling_thread_start",
  "orcling_thread_send",
];

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function registerOrclingTools(mcp: McpServer, tools: OrclingTools, runId: string): void {
  mcp.registerTool(
    "orcling_instructions_update",
    {
      description:
        "Rewrite your own instructions: how you work with this person, in your words. Send the complete new text; it replaces the current version, which the user can restore. Change them when the person tells you how they want you to be, or when you learn something lasting about working together. Say in your reply what you changed. Depending on your permission, the user may be asked first.",
      inputSchema: { body: z.string().trim().min(1).max(20_000), reason: z.string().trim().min(1).max(300) },
    },
    async ({ body, reason }) => text(await tools.updateInstructions(runId, { body, reason })),
  );
  mcp.registerTool(
    "orcling_remember",
    {
      description:
        "Save something lasting about the person you help to your own memory: a preference, a goal or plan, a decision, a routine, a person they work with, or a lesson. Your memory goes with you into every conversation and no project sees it. Reuse a topic_key to replace an older memory on the same topic. Depending on your permission, the user may be asked first.",
      inputSchema: {
        type: z.enum(["preference", "decision", "lesson", "convention", "ownership", "spec"]),
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(800),
        topic_key: z.string().min(1).max(80).optional(),
      },
    },
    async ({ type, title, body, topic_key }) => text(await tools.remember(runId, { type, title, body, ...(topic_key ? { topicKey: topic_key } : {}) })),
  );
  mcp.registerTool(
    "orcling_recall",
    { description: "Search your own memory of the person you help.", inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() } },
    async ({ query, limit }) => text(await tools.recall(runId, query, limit ?? 8)),
  );
  mcp.registerTool(
    "orcling_history",
    {
      description: "Search everything said in your own conversation and wherever else you helped, including earlier sessions that are no longer in your context.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() },
    },
    async ({ query, limit }) => text(await tools.history(runId, query, limit ?? 10)),
  );
  mcp.registerTool("orcling_projects", { description: "The person's Workspace and projects: id, name, folder, and how many tasks are open.", inputSchema: {} }, async () =>
    text(await tools.projects(runId)),
  );
  mcp.registerTool(
    "orcling_project",
    {
      description: "One project at a glance: open tasks, recent threads with their last reply, and its memory. With a query, the project's memory is searched for it instead.",
      inputSchema: { project_id: z.string().min(1), query: z.string().min(1).optional() },
    },
    async ({ project_id, query }) => text(await tools.project(runId, project_id, query)),
  );
  mcp.registerTool(
    "orcling_thread_read",
    { description: "The last messages of any thread in any project, by id from orcling_project.", inputSchema: { thread_id: z.string().min(1), limit: z.number().int().min(1).max(30).optional() } },
    async ({ thread_id, limit }) => text(await tools.readThread(runId, thread_id, limit ?? 10)),
  );
  mcp.registerTool(
    "orcling_task_create",
    {
      description:
        "Save a task to a project's backlog: a concise title and a Markdown spec with Goal, Scope and Acceptance criteria. Saving starts nothing; orcling_thread_start starts it when the person wants the work to begin. Check orcling_project first so you don't repeat an existing task.",
      inputSchema: { project_id: z.string().min(1), title: z.string().trim().min(1).max(200), spec: z.string().max(40_000) },
    },
    async ({ project_id, title, spec }) => text(await tools.createTask(runId, { projectId: project_id, title, spec })),
  );
  mcp.registerTool(
    "orcling_thread_start",
    {
      description:
        "Start work in one of the person's projects: a new thread there where you do the work yourself, on your own model. The prompt says what to do; with a task_id you take up that saved task (orcling_project lists them). Use it when the person asks you to start or do work in a project, then tell them where it runs. Depending on your permission, the person may be asked first.",
      inputSchema: {
        project_id: z.string().min(1),
        prompt: z.string().trim().min(1).max(20_000),
        task_id: z.string().min(1).optional(),
        title: z.string().trim().min(1).max(120).optional(),
      },
    },
    async ({ project_id, prompt, task_id, title }) => text(await tools.startWork(runId, { projectId: project_id, prompt, ...(task_id ? { taskId: task_id } : {}), ...(title ? { title } : {}) })),
  );
  mcp.registerTool(
    "orcling_thread_send",
    {
      description:
        "Send a short message to a thread in any project, to hand it work or ask what it knows. If its agent is working, the message joins the current turn; otherwise it starts one. A thread in a more permissive mode than yours acts with its own permissions, so the user is asked first. Pass the same request_key when retrying. After 20 agent messages in a row with no one writing, sending stops until a person writes.",
      inputSchema: { thread_id: z.string().min(1), text: z.string().min(1).max(4000), request_key: z.string().min(1).max(200).optional() },
    },
    async ({ thread_id, text: message, request_key }) => text(await tools.sendThread(runId, { threadId: thread_id, text: message, ...(request_key ? { requestKey: request_key } : {}) })),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentKind, ExecutionMode } from "@openorc/protocol";

export interface OrclingMemoryEntry {
  type: string;
  title: string;
  body: string;
  topicKey?: string;
}

/** Who does work an Orcling starts: the Orcling itself on its own model, or an agent picked the way the person picks one. */
export type OrclingWorker = { kind: "self" } | { kind: "agent"; agent?: AgentKind; model?: string; effort?: string; fast?: boolean; claudeAccount?: string };

export interface OrclingStartInput {
  /** Where it starts: a project, or under a thread, whose project it is then. */
  projectId?: string;
  under?: string;
  prompt: string;
  taskId?: string;
  title?: string;
  worker: OrclingWorker;
  /** How freely the work runs; without it, as freely as the conversation that asked. */
  access?: ExecutionMode;
  /** A new thread's own worktree and branch, or the project's checkout; without it, the person's default. */
  worktree?: boolean;
  /** The Orcling hears once when the thread's turn ends. */
  reportBack: boolean;
}

/**
 * What an Orcling can do wherever it works: keep its own instructions and
 * memory, search what it said before, and act in OpenOrc for the person:
 * see what runs and what is left of their plans, start work on the agent
 * and model they want, and follow it up. Each call answers in text the
 * model reads directly.
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
  startWork(runId: string, input: OrclingStartInput): Promise<string>;
  sendThread(runId: string, input: { threadId: string; text: string; requestKey?: string; reportBack: boolean }): Promise<string>;
  /** Threads working, waiting on the person, failed or unread, across every project. */
  activity(runId: string): Promise<string>;
  /** The agents the person has turned on, their models and efforts, the default for new threads, and Claude accounts. */
  models(runId: string, agent: AgentKind | undefined, search?: string): Promise<string>;
  /** What is left of each plan the person has, per account and usage window. */
  usage(runId: string): Promise<string>;
  /** What else the Orcling can do in OpenOrc for the person; with a method, that method's parameters. */
  appMethods(runId: string, method: string | undefined): Promise<string>;
  /** One thing the person could do in OpenOrc, done for them. */
  app(runId: string, method: string, params: unknown): Promise<string>;
  /** The person's other Orclings and the group chats this one is in. */
  orclings(runId: string): Promise<string>;
  /** A direct message to another Orcling, which lands in its own chat as this Orcling's. */
  message(runId: string, input: { to: string; text: string }): Promise<string>;
  /** A group chat with the person and the Orclings named, opened with these words. */
  startGroup(runId: string, input: { with: string[]; title?: string; text: string }): Promise<string>;
  /** A tapback on the person's newest message in the Orcling's own conversation. */
  react(runId: string, reaction: "heart" | "like" | "dislike" | "haha" | "wow" | "sad"): Promise<string>;
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
  "orcling_activity",
  "orcling_models",
  "orcling_usage",
  "orcling_app_methods",
  "orcling_app",
  "orcling_react",
  "orcling_orclings",
  "orcling_message",
  "orcling_group_start",
];

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function registerOrclingTools(mcp: McpServer, tools: OrclingTools, runId: string): void {
  registerOrclingTalk(mcp, tools, runId);
  if (tools.ownConversation(runId))
    mcp.registerTool(
      "orcling_react",
      {
        description:
          "React to the person's newest message with a tapback, the way people do in a chat: heart, like, dislike, haha, wow or sad. Use it when a reaction says it better than words, such as a heart for thanks or haha for a joke. A reaction can be your whole reply: after it, reply with only NO_REPLY, which nobody sees.",
        inputSchema: { reaction: z.enum(["heart", "like", "dislike", "haha", "wow", "sad"]) },
      },
      async ({ reaction }) => text(await tools.react(runId, reaction)),
    );
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
      description:
        "One project at a glance: open tasks, recent threads with their status (working, needs the person, failed, unread) and when each was last active, and the project's memory. With a query, the project's memory is searched for it instead.",
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
  registerOrclingWork(mcp, tools, runId);
  registerOrclingOverview(mcp, tools, runId);
}

/** Handing out work for the person and steering it: a new thread or task, or a message to one already going. */
function registerOrclingWork(mcp: McpServer, tools: OrclingTools, runId: string): void {
  mcp.registerTool(
    "orcling_thread_start",
    {
      description:
        'Start work in one of the person\'s projects, as the person would start a thread. It runs on their usual agent and model unless you name others: agent, model and effort take loose names such as "opus 5.5" or "extra high" (orcling_models lists them), fast turns on Fast mode, and claude_account picks the Claude account by name. access sets how freely it works: plan, review (asks before every command or edit), trusted (edits files, asks before commands) or autonomous (runs tools without asking); without it, it works as freely as this conversation, and your own permission caps it either way. Set yourself to do the work as yourself, on your own model, instead. With a task_id it takes up that saved task (orcling_project lists them). With under, it starts as a subthread of that thread, in its folder, and project_id can be left out. worktree: true gives a new thread its own worktree and branch, false puts it on the project checkout; without it, the default the person chose. Set report_back to hear once when its turn ends, so you can follow up or tell the person. Use it when the person asks for work in a project, then tell them where it runs and on what. Depending on your permission, the person may be asked first.',
      inputSchema: {
        project_id: z.string().min(1).optional(),
        under: z.string().min(1).optional(),
        prompt: z.string().trim().min(1).max(20_000),
        task_id: z.string().min(1).optional(),
        title: z.string().trim().min(1).max(120).optional(),
        agent: AgentKind.optional(),
        model: z.string().trim().min(1).max(120).optional(),
        effort: z.string().trim().min(1).max(40).optional(),
        fast: z.boolean().optional(),
        claude_account: z.string().trim().min(1).max(80).optional(),
        yourself: z.boolean().optional(),
        access: ExecutionMode.optional(),
        worktree: z.boolean().optional(),
        report_back: z.boolean().optional(),
      },
    },
    async (input) =>
      text(
        await tools.startWork(runId, {
          ...(input.project_id ? { projectId: input.project_id } : {}),
          ...(input.under ? { under: input.under } : {}),
          prompt: input.prompt,
          ...(input.task_id ? { taskId: input.task_id } : {}),
          ...(input.title ? { title: input.title } : {}),
          worker: workerOf(input),
          ...(input.access ? { access: input.access } : {}),
          ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
          reportBack: input.report_back ?? false,
        }),
      ),
  );
  mcp.registerTool(
    "orcling_thread_send",
    {
      description:
        "Send a short message to a thread in any project, to hand it work, steer it or ask what it knows. If its agent is working, the message joins the current turn; otherwise it starts one. Set report_back to hear once when that turn ends. A thread in a more permissive mode than yours acts with its own permissions, so the user is asked first. Pass the same request_key when retrying. After 50 agent messages in a row with no one writing, sending stops until a person writes.",
      inputSchema: { thread_id: z.string().min(1), text: z.string().min(1).max(4000), request_key: z.string().min(1).max(200).optional(), report_back: z.boolean().optional() },
    },
    async ({ thread_id, text: message, request_key, report_back }) =>
      text(await tools.sendThread(runId, { threadId: thread_id, text: message, ...(request_key ? { requestKey: request_key } : {}), reportBack: report_back ?? false })),
  );
}

/** The person's OpenOrc as they would see it: what runs right now, what work can run on, and what is left of their plans. */
function registerOrclingOverview(mcp: McpServer, tools: OrclingTools, runId: string): void {
  mcp.registerTool(
    "orcling_activity",
    {
      description:
        "What is happening right now across all of the person's projects: threads working, waiting on the person and for what, failed, or finished with a reply they haven't read, each with its project, agent, model and exact times. Check it before saying what is running.",
      inputSchema: {},
    },
    async () => text(await tools.activity(runId)),
  );
  mcp.registerTool(
    "orcling_models",
    {
      description:
        "The agents the person has turned on and their models with effort levels, the agent new threads start on and why, and the person's Claude accounts. An agent with many models lists the ones that matter to the person (last used, used lately, its default) and a count per provider; search finds any model by name or provider, older ones too. Use it to choose what work runs on.",
      inputSchema: { agent: AgentKind.optional(), search: z.string().trim().min(1).max(80).optional() },
    },
    async ({ agent, search }) => text(await tools.models(runId, agent, search)),
  );
  mcp.registerTool(
    "orcling_usage",
    {
      description:
        "How much the person has left on each plan: every provider and account, with each usage window's percent used and when it resets. Check it before starting large work, or to pick an account or agent with room.",
      inputSchema: {},
    },
    async () => text(await tools.usage(runId)),
  );
  mcp.registerTool(
    "orcling_app_methods",
    {
      description:
        "Everything else you can do in OpenOrc for the person, as their phone would: read and organize threads, answer approvals, commit, push and open pull requests, review pull requests and post the review, read, edit and comment on tasks, look after Orclings, move threads to the cloud. Without a method, the list of what reads and what changes; with one, its parameters.",
      inputSchema: { method: z.string().trim().min(1).max(80).optional() },
    },
    async ({ method }) => text(await tools.appMethods(runId, method)),
  );
  mcp.registerTool(
    "orcling_app",
    {
      description:
        "Do one thing in OpenOrc the person could do themselves, by method and parameters from orcling_app_methods; it answers as OpenOrc answers them. Reads never ask. A change follows your permission: it may ask the person first, and in Plan it is refused. Prefer your own tools where one fits, such as orcling_thread_start.",
      inputSchema: { method: z.string().trim().min(1).max(80), params: z.record(z.string(), z.unknown()).optional() },
    },
    async ({ method, params }) => text(await tools.app(runId, method, params ?? {})),
  );
}

/** Who the call asks to do the work. Yourself is the Orcling on its own model, so it names no other. */
function workerOf({
  yourself,
  agent,
  model,
  effort,
  fast,
  claude_account,
}: {
  yourself?: boolean;
  agent?: AgentKind;
  model?: string;
  effort?: string;
  fast?: boolean;
  claude_account?: string;
}): OrclingWorker {
  if (yourself) {
    const named = Object.entries({ agent, model, effort, fast, claude_account }).flatMap(([key, value]) => (value === undefined ? [] : [key]));
    if (named.length) throw new Error(`yourself works on your own model, so it takes no ${named.join(" or ")}. Leave yourself out to start it on another.`);
    return { kind: "self" };
  }
  return {
    kind: "agent",
    ...(agent && { agent }),
    ...(model && { model }),
    ...(effort && { effort }),
    ...(fast !== undefined && { fast }),
    ...(claude_account && { claudeAccount: claude_account }),
  };
}

/** Talking to the person's other Orclings: who they are, a direct message, a group chat. */
function registerOrclingTalk(mcp: McpServer, tools: OrclingTools, runId: string): void {
  mcp.registerTool("orcling_orclings", { description: "The person's other Orclings, by name and whether they are busy, and the group chats you are in.", inputSchema: {} }, async () =>
    text(await tools.orclings(runId)),
  );
  mcp.registerTool(
    "orcling_message",
    {
      description:
        "Text another of the person's Orclings directly, by name. It lands in that Orcling's own chat as yours, where the person can read it, and its answer reaches you the same way. Use it when another Orcling can help or needs to know something, not to chat; keep it short. Depending on your permission and theirs, the person may be asked first. Messages between Orclings stop after a few in a row until the person writes.",
      inputSchema: { to: z.string().trim().min(1).max(40), text: z.string().trim().min(1).max(4000) },
    },
    async ({ to, text: message }) => text(await tools.message(runId, { to, text: message })),
  );
  mcp.registerTool(
    "orcling_group_start",
    {
      description:
        "Open a group chat with the person and the Orclings you name, and say the first thing in it. Each of them answers in turn; after that, whoever a message names answers. Use it when a few Orclings and the person should work something out together. Depending on your permission, the person may be asked first.",
      inputSchema: {
        with: z.array(z.string().trim().min(1).max(40)).min(1).max(7),
        title: z.string().trim().min(1).max(60).optional(),
        text: z.string().trim().min(1).max(4000),
      },
    },
    async ({ with: names, title, text: message }) => text(await tools.startGroup(runId, { with: names, ...(title ? { title } : {}), text: message })),
  );
}

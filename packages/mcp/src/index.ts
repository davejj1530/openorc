import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { UserInput, type UserInputResult } from "./questions.js";
export { UserInput, validateUserAnswers, type UserInputResult } from "./questions.js";
import { TaskStatus, HarnessId, CommentIntent, parseFileBoundary, type ApprovalDecision, type BrowserCommand, type BrowserResult } from "@openorc/protocol";
import { registerBrowserTool } from "./browser.js";
import { fileBoundaryAnswer } from "./file-boundary.js";

export interface ExecutionSwitchInput {
  agent?: HarnessId;
  model?: string;
  /** Exact catalog effort, or null to use the model's default. */
  effort?: string | null;
  folderId?: string;
  instructions: string;
}

export interface ApprovalRequest {
  runId: string;
  approvalId: string;
  toolName: string;
  input: unknown;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  message?: string;
  updatedInput?: unknown;
  /** Answers to AskUserQuestion, keyed by question text. */
  answers?: Record<string, string[]>;
}

export interface MemorySearchHit {
  id: string;
  type: string;
  title: string;
  summary: string;
  ageDays: number;
  confidence: number;
}

/**
 * What the server needs from the host. The core process implements this
 * against the ledger and the UI; spikes implement it with stubs.
 */
export interface McpHost {
  /** Whether a run's process is still running. Calls for any other run are refused. Hosts without it accept every issued token. */
  live?(runId: string): boolean;
  browser?(runId: string, command: BrowserCommand): Promise<BrowserResult>;
  commentTurn?: { isComment(runId: string): boolean; intent(runId: string, input: CommentIntent): Promise<unknown> };
  askUser?(runId: string, requestId: string, input: UserInput, signal: AbortSignal): Promise<UserInputResult>;
  /** The plan document of a Plan-mode run whose harness has no native one. */
  plan?: { available(runId: string): boolean; write(runId: string, text: string): Promise<void> };
  approve(request: ApprovalRequest): Promise<ApprovalResult>;
  /** Omit memory tools while recall and recording are disabled. Task context stays available. */
  memoryEnabled?(): boolean;
  memorySearch(runId: string, query: string, limit: number): Promise<MemorySearchHit[]>;
  taskContext(runId: string): Promise<string>;
  memoryRecord(runId: string, entry: { type: string; title: string; body: string; topicKey?: string }): Promise<{ id: string }>;
  memoryFeedback(runId: string, id: string, verdict: "helpful" | "wrong" | "stale"): Promise<void>;
  tasks: TaskTools;
  threads: ThreadTools;
  /** Execution choices scoped to the authenticated, active Slack run. */
  execution?: {
    available(runId: string): boolean;
    context(runId: string): Promise<unknown>;
    switch(runId: string, input: ExecutionSwitchInput): Promise<unknown>;
  };
  /** Available when the host supports authenticated team execution. */
  team?: TeamTools;
}

/** The host derives the team actor and execution from the authenticated run. */
export interface TeamTools {
  available(runId: string): boolean;
  status(runId: string): Promise<unknown>;
  message(runId: string, input: { recipientId: string; text: string; requestKey: string }): Promise<unknown>;
  /** Speak in the team chat, to named colleagues, mentions or the lead. */
  say(runId: string, input: { text: string; to?: string[]; requestKey?: string }): Promise<unknown>;
  /** Claim or release files in the shared team workspace. */
  claim(runId: string, input: { paths: string[]; note?: string; release?: boolean }): Promise<unknown>;
  wait(runId: string, input: { assignmentIds?: string[] }): Promise<unknown>;
  complete(runId: string, input: { result: string }): Promise<unknown>;
  /** Verbatim history a context handoff stored by id because of size. */
  context(runId: string, input: { id: string }): Promise<{ id: string; bytes: number; text: string }>;
  /** A page of the team room, oldest first, scoped to the caller's conversation. */
  history(runId: string, input: { afterSeq?: number; beforeSeq?: number; limit?: number }): Promise<unknown>;
}

export interface ThreadCard {
  id: string;
  title: string;
  activity: "idle" | "running" | "waiting";
  branch: string | null;
  /** True when this is the thread the calling run belongs to. */
  current: boolean;
  lastReply: string | null;
  lastActivityAt: number;
}

export interface ThreadTools {
  /** The project's active threads, the caller's marked current. */
  list(runId: string): Promise<ThreadCard[]>;
  /** The last few messages of a thread in the same project. */
  read(runId: string, id: string, limit?: number): Promise<{ thread: ThreadCard; messages: { role: string; text: string }[] } | null>;
  /** Delivers a message into another thread: into its running turn, or as a new turn when idle. A team lead receives it as queued direction. */
  send(runId: string, id: string, text: string, requestKey?: string): Promise<{ delivered: boolean; message: string }>;
}

export interface TaskCard {
  spec?: string | null;
  message?: string;
  id: string;
  title: string;
  status: string;
  branch: string | null;
  /** True when this is the task the calling run is executing. */
  current: boolean;
  resultSummary: string | null;
  activity?: {
    runId: string;
    state: "working" | "waiting" | "idle" | "completed" | "failed" | "cancelled";
    latestMessage: string | null;
    lastAction: string | null;
    waitingFor: string | null;
    updatedAt: number;
  } | null;
}

export interface TaskTools {
  /** Creates a task in the caller's thread, or returns the existing one when the title matches. */
  create(
    runId: string,
    input: {
      title: string;
      spec: string;
      priority?: string;
      labels?: string[];
      execution?: "backlog" | "delegate";
      workspaceMode?: "current" | "worktree";
      memberKey?: string;
      requestKey?: string;
      dependencies?: string[];
      dependencyTaskIds?: string[];
    },
  ): Promise<{ task: TaskCard; duplicate: boolean; started: boolean; message: string }>;
  start(
    runId: string,
    id: string,
    options?: { workspaceMode?: "current" | "worktree"; admissionId?: string; memberKey?: string; requestKey?: string },
  ): Promise<TaskCard & { admissionId?: string; message?: string }>;
  complete?(runId: string, input: { taskId: string; admissionId?: string; result: string }): Promise<unknown>;
  list(runId: string): Promise<TaskCard[]>;
  get(runId: string, id: string): Promise<TaskCard | null>;
  update(runId: string, id: string, patch: { status?: TaskStatus; spec?: string }): Promise<TaskCard | null>;
}

export interface OpenOrcMcpServer {
  port: number;
  /** URL to hand to an agent for a given run. The token scopes tool calls to that run. */
  urlForRun(runId: string): string;
  /** Ends a run's access: its token stops working. */
  revoke(runId: string): void;
  close(): Promise<void>;
}

/**
 * One HTTP server on the loopback interface, one secret path per run. Stateless streamable HTTP: a fresh MCP server
 * object per request, so a crashed agent never leaks a session. Agent CLIs send no Origin header and address the
 * server by its IP, so a request with an Origin, or naming another host, comes from a web page and is refused: the
 * DNS-rebinding defence. `<run address>/file-boundary` answers the Claude adapter's file-boundary hook for that run.
 */
export async function startMcpServer(host: McpHost, options: { port?: number; hostname?: string } = {}): Promise<OpenOrcMcpServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const tokens = new Map<string, string>(); // token -> runId
  let port = 0;

  const server = http.createServer(async (req, res) => {
    if (req.headers.origin !== undefined || req.headers.host !== `${hostname}:${port}`) {
      res.writeHead(403, { "content-type": "text/plain" }).end("refused");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${hostname}`);
    const match = /^\/mcp\/([A-Za-z0-9_-]+)(\/file-boundary)?$/.exec(url.pathname);
    const runId = match ? tokens.get(match[1] ?? "") : undefined;
    if (!runId || (host.live && !host.live(runId))) {
      res.writeHead(404, { "content-type": "text/plain" }).end("unknown run");
      return;
    }
    if (match?.[2]) {
      await answerFileBoundary(req, res, url.searchParams);
      return;
    }
    const mcp = buildServer(host, runId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, hostname, resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    urlForRun(runId) {
      let token = [...tokens.entries()].find(([, id]) => id === runId)?.[0];
      if (!token) {
        token = randomUUID().replace(/-/g, "");
        tokens.set(token, runId);
      }
      return `http://${hostname}:${port}/mcp/${token}`;
    },
    revoke(runId) {
      for (const [token, id] of tokens) if (id === runId) tokens.delete(token);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

/** A Write request carries the whole file, so the limit is generous. */
const HOOK_BODY_LIMIT = 64 * 1024 * 1024;

/** Answers one hook request. Any status other than 200 makes the hook exit 2, which blocks the tool. */
async function answerFileBoundary(req: http.IncomingMessage, res: http.ServerResponse, query: URLSearchParams): Promise<void> {
  const boundary = parseFileBoundary(query);
  if (req.method !== "POST" || !boundary) {
    res.writeHead(400, { "content-type": "text/plain" }).end("expected a POST with a boundary");
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > HOOK_BODY_LIMIT) throw new Error("The request is too large to check.");
      chunks.push(chunk);
    }
    const answer = fileBoundaryAnswer(boundary, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  } catch (e) {
    res.writeHead(422, { "content-type": "text/plain" }).end(e instanceof Error ? e.message : String(e));
  }
}

/** App actions eligible for internal approval; the approval bridge itself is excluded. */
export const internalToolNames = [
  "browser",
  "ask_user",
  "plan_write",
  "memory_search",
  "task_context",
  "memory_record",
  "memory_feedback",
  "task_create",
  "task_start",
  "task_complete",
  "task_list",
  "task_get",
  "task_update",
  "thread_list",
  "thread_read",
  "thread_send",
  "execution_context",
  "execution_switch",
  "team_status",
  "team_message",
  "team_wait",
  "team_complete",
  "team_context",
  "team_say",
  "team_claim",
  "team_history",
];

function requireTeam(host: McpHost): TeamTools {
  if (!host.team) throw new Error("Team tools are unavailable in this host.");
  return host.team;
}

/** Translate a host decision into Claude Code's permission-prompt response. */
function approvalPayload(toolName: string, input: Record<string, unknown>, result: ApprovalResult): { behavior: "deny"; message: string } | { behavior: "allow"; updatedInput: unknown } {
  if (result.decision === "deny") return { behavior: "deny", message: result.message ?? "Denied by the user in OpenOrc." };
  if (toolName !== "AskUserQuestion" || !result.answers) return { behavior: "allow", updatedInput: result.updatedInput ?? input };

  // Claude reads the user's choices back from updatedInput.answers, one string per question.
  const answers: Record<string, string> = {};
  for (const [question, values] of Object.entries(result.answers)) answers[question] = values.join(", ");
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

function buildServer(host: McpHost, runId: string): McpServer {
  const mcp = new McpServer({ name: "openorc", version: "0.0.0" });
  const memoryEnabled = host.memoryEnabled?.() !== false;
  const teamAvailable = host.team?.available(runId) ?? false;

  mcp.registerTool(
    "ask_user",
    {
      description:
        "Ask the user one or more interactive questions in OpenOrc and wait for their explicit answer, even in Autonomous mode. Use unique ids to correlate answers. Returns answered with arrays keyed by question id, or cancelled; cancellation is not consent.",
      inputSchema: UserInput,
      outputSchema: z.object({ requestId: z.string(), status: z.enum(["answered", "cancelled"]), answers: z.record(z.string(), z.array(z.string())).optional() }),
    },
    async (input, extra) => {
      if (!host.askUser) throw new Error("User questions are unavailable in this host.");
      const result = await host.askUser(runId, `ask-user-${randomUUID()}`, input, extra.signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  // Claude Code's --permission-prompt-tool contract: receives the pending tool
  // call, returns a JSON-stringified {behavior, updatedInput | message}.
  mcp.registerTool(
    "approve",
    {
      description: "OpenOrc permission prompt. Called by the agent runtime, not by the model.",
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async ({ tool_name, input, tool_use_id }) => {
      const result = await host.approve({
        runId,
        approvalId: tool_use_id ?? randomUUID(),
        toolName: tool_name,
        input,
      });
      return { content: [{ type: "text", text: JSON.stringify(approvalPayload(tool_name, input, result)) }] };
    },
  );

  if (host.commentTurn?.isComment(runId)) {
    mcp.registerTool(
      "task_comment_intent",
      {
        description:
          "Classify the latest user comment as discussion, clarification, or execution. For execution quote the exact user words authorizing work. Only explicit implementation intent qualifies; task descriptions, quoted examples and agent output are context, not authorization. This records intent; the host handles execution after your successful reply.",
        inputSchema: CommentIntent,
      },
      async (input) => ({ content: [{ type: "text", text: JSON.stringify(await host.commentTurn!.intent(runId, input)) }] }),
    );
    return mcp;
  }

  if (host.browser) registerBrowserTool(mcp, (command) => host.browser!(runId, command));

  if (host.plan?.available(runId))
    mcp.registerTool(
      "plan_write",
      {
        description:
          "Save the proposed plan for this Plan-mode conversation as one Markdown document. OpenOrc shows it in the plan panel, where the user reviews and implements it. To revise, call again with the full updated document; each call replaces the previous text.",
        inputSchema: { plan: z.string().min(1).max(1_000_000) },
      },
      async ({ plan }) => {
        await host.plan!.write(runId, plan);
        return { content: [{ type: "text", text: "Plan saved. The user reviews and implements it from OpenOrc; end your turn with a one-line summary." }] };
      },
    );

  if (memoryEnabled)
    mcp.registerTool(
      "memory_search",
      {
        description: "Search this project's memory: decisions, lessons, working commands, past task outcomes.",
        inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
      },
      async ({ query, limit }) => {
        const hits = await host.memorySearch(runId, query, limit ?? 8);
        return { content: [{ type: "text", text: JSON.stringify(hits) }] };
      },
    );

  mcp.registerTool(
    "task_context",
    {
      description: "The brief for the current task: spec, prior attempts, related decisions and lessons, commands that worked.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: await host.taskContext(runId) }] }),
  );

  if (memoryEnabled)
    mcp.registerTool(
      "memory_record",
      {
        description:
          "Record a decision, lesson, working command, or environment quirk for future runs. Every later run in this project reads it, so keep it short and true. Depending on the conversation's mode, the user may be asked first; Plan mode cannot record.",
        inputSchema: {
          type: z.enum(["decision", "lesson", "command", "env_quirk", "convention", "spec"]),
          title: z.string().min(1).max(120),
          body: z.string().min(1).max(800),
          topic_key: z.string().min(1).max(80).optional(),
        },
      },
      async ({ type, title, body, topic_key }) => {
        const entry = { type, title, body, ...(topic_key ? { topicKey: topic_key } : {}) };
        const { id } = await host.memoryRecord(runId, entry);
        return { content: [{ type: "text", text: JSON.stringify({ id, recorded: true }) }] };
      },
    );

  if (memoryEnabled)
    mcp.registerTool(
      "memory_feedback",
      {
        description:
          "Report whether a memory (by id from memory_search) was helpful, wrong, or stale, so it is reinforced or retired. Only the user can retract a memory they wrote. Depending on the conversation's mode, the user may be asked first; Plan mode cannot give feedback.",
        inputSchema: { id: z.string(), verdict: z.enum(["helpful", "wrong", "stale"]) },
      },
      async ({ id, verdict }) => {
        await host.memoryFeedback(runId, id, verdict);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    );

  mcp.registerTool(
    "task_create",
    {
      description:
        "Create a polished task document directly in OpenOrc. A task is work the user asked to have saved or built. Conversation is not a task: greetings, questions, opinions, status and coordination are answered in your reply or with team_say, never captured or delegated as tasks. Defaults to backlog: no agent starts and no worktree is created, even in Act mode. 'Create a task' or 'add to backlog' requests capture, not implementation: save with execution=backlog and confirm. Act permits the requested action; it never overrides the user's intent. For ordinary tasks, creation only saves the document, including legacy execution=delegate requests. When asked to implement, call task_start and do the work in this same conversation; never forward it to a separate task agent. execution=delegate is only for explicit saved-team delegation. In a team execution, delegation and proposals require member_key and request_key. Backlog capture can also retain member_key and dependency_task_ids; dependencies instead identifies current assignment IDs. The host checks the caller's team hierarchy and permissions. Use MCP directly, not Computer Use, browser automation, or database writes. Call task_list first to avoid duplicates. Outside team execution, only threads can create tasks.",
      inputSchema: {
        title: z.string().min(3).max(120).describe("Imperative, specific, unique within the thread"),
        spec: z
          .string()
          .min(10)
          .describe(
            "Well-written Markdown document: Goal, Scope, Acceptance criteria (checklist), and Verification. Include relevant constraints and concrete outcomes; omit empty sections and do not invent requirements.",
          ),
        priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
        labels: z.array(z.string().min(1).max(60)).max(20).optional(),
        execution: z.enum(["backlog", "delegate"]).default("backlog").describe("Backlog saves only. Delegate is for explicit saved-team assignments; ordinary tasks always save only."),
        workspace_mode: z
          .enum(["current", "worktree"])
          .optional()
          .describe(
            "Ordinary tasks only: current uses the existing checkout and branch, worktree creates an isolated workspace. Omit to save the user’s default. Exclusive workspace operations can block local startup; never silently fall back to a worktree.",
          ),
        member_key: z.string().min(1).optional().describe("Saved direct-report member key. Required for team delegation and proposals; optional intended assignee for backlog capture."),
        request_key: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Stable idempotency key for this team task. Reuse it when retrying the same request. Required for team delegation or proposals; recommended for backlog capture."),
        dependencies: z.array(z.string().min(1)).optional().describe("Assignment IDs that must finish before this team assignment can run."),
        dependency_task_ids: z
          .array(z.string().min(1))
          .max(100)
          .optional()
          .describe("Task IDs to retain as dependencies when saving a team backlog task or Plan proposal. Do not combine with dependencies. Immediate delegation uses assignment IDs instead."),
      },
    },
    async ({ title, spec, priority, labels, execution, workspace_mode, member_key, request_key, dependencies, dependency_task_ids }) => {
      const result = await host.tasks.create(runId, {
        title,
        spec,
        execution,
        ...(workspace_mode !== undefined ? { workspaceMode: workspace_mode } : {}),
        ...(priority ? { priority } : {}),
        ...(labels ? { labels } : {}),
        ...(member_key !== undefined ? { memberKey: member_key } : {}),
        ...(request_key !== undefined ? { requestKey: request_key } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(dependency_task_ids !== undefined ? { dependencyTaskIds: dependency_task_ids } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  mcp.registerTool(
    "task_start",
    {
      description:
        "Mark an existing ordinary task in progress and implement it yourself in the current conversation and workspace. This does not launch or forward to another agent. Or route an explicitly accepted team request through its saved manager hierarchy. Requires Act mode. Reuse the task ID and admission_id; member_key selects a saved direct report. Creating a backlog task does not require starting it.",
      inputSchema: {
        id: z.string().min(1),
        workspace_mode: z
          .enum(["current", "worktree"])
          .optional()
          .describe("Ordinary tasks run in the current conversation workspace. Omit this field; a different location requires moving the thread."),
        admission_id: z.string().min(1).optional(),
        member_key: z.string().min(1).optional(),
        request_key: z.string().min(1).max(200).optional(),
      },
    },
    async ({ id, workspace_mode, admission_id, member_key, request_key }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await host.tasks.start(runId, id, {
              ...(workspace_mode !== undefined ? { workspaceMode: workspace_mode } : {}),
              ...(admission_id ? { admissionId: admission_id } : {}),
              ...(member_key ? { memberKey: member_key } : {}),
              ...(request_key ? { requestKey: request_key } : {}),
            }),
          ),
        },
      ],
    }),
  );

  if (teamAvailable && host.tasks.complete)
    mcp.registerTool(
      "task_complete",
      {
        description:
          "Record completion intent for your accepted team task. A lead handling a task itself must supply its admission_id. The result becomes final only after this turn succeeds and its output is captured. An assigned worker may also use team_complete.",
        inputSchema: { id: z.string().min(1), admission_id: z.string().min(1).optional(), result: z.string().trim().min(1).max(100000) },
      },
      async ({ id, admission_id, result }) => {
        if (!host.tasks.complete) throw new Error("Task completion is unavailable in this host.");
        return { content: [{ type: "text", text: JSON.stringify(await host.tasks.complete(runId, { taskId: id, result, ...(admission_id ? { admissionId: admission_id } : {}) })) }] };
      },
    );

  mcp.registerTool(
    "task_list",
    { description: "Tasks across all threads in this project with their status and branch. The task you are executing, if any, is marked current.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await host.tasks.list(runId)) }] }),
  );

  mcp.registerTool(
    "task_get",
    {
      description:
        "Read any task in this project by ID, regardless of its originating thread or team. Live progress includes: latest agent commentary, current action, permission/input wait, run outcome, and result summary. Use this when the user asks for a report; waiting means paused, not still implementing.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({ content: [{ type: "text", text: JSON.stringify(await host.tasks.get(runId, id)) }] }),
  );

  mcp.registerTool(
    "task_update",
    {
      description:
        "Update any task in this project by ID, regardless of its originating thread, team or assigned agent. Set its board status or refine its spec. A status move does not stop an execution or change its recorded outcome.",
      inputSchema: { id: z.string(), status: TaskStatus.optional(), spec: z.string().optional() },
    },
    async ({ id, status, spec }) => ({ content: [{ type: "text", text: JSON.stringify(await host.tasks.update(runId, id, { ...(status ? { status } : {}), ...(spec ? { spec } : {}) })) }] }),
  );

  if (host.execution?.available(runId)) {
    mcp.registerTool(
      "execution_context",
      {
        description:
          "Inspect this active Slack conversation's model, configured reasoning effort, harness and working folder, plus available models with supported efforts/defaults and the folder catalog. A null current effort means the model's default. Use this to answer settings questions or choose a requested switch.",
        inputSchema: {},
      },
      async () => {
        if (!host.execution) throw new Error("Execution tools are unavailable in this host.");
        return { content: [{ type: "text", text: JSON.stringify(await host.execution.context(runId)) }] };
      },
    );
    mcp.registerTool(
      "execution_switch",
      {
        description:
          "Queue a model/harness, reasoning effort, or folder change requested by the Slack owner, using exact IDs and supported efforts from execution_context. Effort can change alone; null resets it to the model's default. Omitted effort is preserved for the same model; a different model uses its default. Supply the owner's remaining task as instructions. After acceptance, end your turn immediately: OpenOrc continues this same conversation automatically with those settings. Permissions remain unchanged.",
        inputSchema: {
          agent: HarnessId.optional(),
          model: z.string().min(1).optional(),
          effort: z.string().min(1).nullable().optional(),
          folderId: z.string().min(1).optional(),
          instructions: z.string().min(1).max(20000),
        },
      },
      async (input) => {
        if (!host.execution) throw new Error("Execution tools are unavailable in this host.");
        if (!input.agent && !input.model && input.effort === undefined && !input.folderId) throw new Error("Choose a model, harness, effort or folder to switch.");
        return { content: [{ type: "text", text: JSON.stringify(await host.execution.switch(runId, input)) }] };
      },
    );
  }
  mcp.registerTool(
    "thread_list",
    { description: "The other conversations (threads) open on this project: what each is doing and its last reply. Your own thread is marked current.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await host.threads.list(runId)) }] }),
  );

  mcp.registerTool(
    "thread_read",
    { description: "The last messages of another thread in this project, by id from thread_list.", inputSchema: { id: z.string(), limit: z.number().int().min(1).max(30).optional() } },
    async ({ id, limit }) => ({ content: [{ type: "text", text: JSON.stringify(await host.threads.read(runId, id, limit)) }] }),
  );

  mcp.registerTool(
    "thread_send",
    {
      description:
        "Send a short message to another thread in this project. If its agent is working, the message joins the current turn; otherwise it starts a new turn. A team's lead receives it as queued direction while that team is running. Use it when that thread's work depends on yours, or to ask for something it knows. Pass the same request_key when retrying so the message is delivered once. A thread that works in a more permissive mode than yours acts on the message with its own permissions, so the user is asked first; from Plan mode you can message only Plan threads. After 4 agent messages in a row with no one writing, sending stops until a person writes.",
      inputSchema: { id: z.string(), text: z.string().min(1).max(4000), request_key: z.string().min(1).max(200).optional() },
    },
    async ({ id, text, request_key }) => ({ content: [{ type: "text", text: JSON.stringify(await host.threads.send(runId, id, text, request_key)) }] }),
  );

  if (!teamAvailable) return mcp;

  mcp.registerTool(
    "team_status",
    {
      description: "Read your team execution, assigned work, and current progress. Your identity and visibility come from this run; the host enforces team membership and hierarchy.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await requireTeam(host).status(runId)) }] }),
  );

  mcp.registerTool(
    "team_message",
    {
      description:
        "Send a message to the lead or an assignment in your team execution. Use a recipient ID from team_status. Reuse the request key when retrying the same message. The host checks the recipient and your authority. Messages enter the active turn when confirmed steering is supported, otherwise they remain queued. A reserved or claimed message is still awaiting provider acknowledgment; delivery never proves the recipient acted on it.",
      inputSchema: {
        recipient_id: z.string().min(1).describe("Lead or assignment recipient ID from team_status."),
        text: z.string().min(1),
        request_key: z.string().min(1).describe("Stable idempotency key for this message."),
      },
    },
    async ({ recipient_id, text, request_key }) => ({
      content: [{ type: "text", text: JSON.stringify(await requireTeam(host).message(runId, { recipientId: recipient_id, text, requestKey: request_key })) }],
    }),
  );

  mcp.registerTool(
    "team_say",
    {
      description:
        "Say something in the team chat. Address colleagues or the lead by member key in `to`, or mention them as @Name in the text; addressed members are woken with your message and reply in the chat, which the user sees. Without `to` or mentions the message goes to the lead. Everyone else reads it as context on their next turn. A delivery marked sending is awaiting provider acknowledgment, not proof of reading or action; one marked read means that member already holds the user's request and reads yours without a reply turn. Route user corrections only to affected recipients; do not copy prior reply recipients or broadcast routine acknowledgments. Use a stable request_key when retrying the same message.",
      inputSchema: {
        text: z.string().min(1).max(100_000),
        to: z.array(z.string().min(1).max(200)).max(50).optional().describe('Member keys from team_status, "lead" or "all".'),
        request_key: z.string().min(1).max(200).optional(),
      },
    },
    async ({ text, to, request_key }) => ({
      content: [{ type: "text", text: JSON.stringify(await requireTeam(host).say(runId, { text, ...(to ? { to } : {}), ...(request_key ? { requestKey: request_key } : {}) })) }],
    }),
  );

  mcp.registerTool(
    "team_claim",
    {
      description:
        "Claim files you are about to edit in the shared team workspace, so colleagues see them and are refused the same paths; pass release=true when you are done. Paths are relative to the workspace. A path a colleague holds is refused: ask them in the chat instead.",
      inputSchema: {
        paths: z.array(z.string().min(1).max(4096)).min(1).max(50),
        note: z.string().max(2000).optional().describe("What you are doing with these files."),
        release: z.boolean().optional(),
      },
    },
    async ({ paths, note, release }) => ({
      content: [{ type: "text", text: JSON.stringify(await requireTeam(host).claim(runId, { paths, ...(note ? { note } : {}), ...(release ? { release } : {}) })) }],
    }),
  );

  mcp.registerTool(
    "team_wait",
    {
      description:
        "Record that you are waiting for assignments or a team message, then end your turn. Returns promptly; the coordinator resumes you when the condition is met. The host checks which assignments you can wait for.",
      inputSchema: {
        assignment_ids: z.array(z.string().min(1)).optional().describe("Assignment IDs to wait for. Omit to wait for a team message or relevant progress."),
      },
    },
    async ({ assignment_ids }) => ({ content: [{ type: "text", text: JSON.stringify(await requireTeam(host).wait(runId, assignment_ids !== undefined ? { assignmentIds: assignment_ids } : {})) }] }),
  );

  mcp.registerTool(
    "team_complete",
    {
      description:
        "Record your completion intent and result, then finish your turn. For the lead this completes the team execution; for a delegated member it completes the current assignment. Required children must be resolved. Completion becomes final only after a successful provider turn and captured output.",
      inputSchema: { result: z.string().min(1).describe("A useful result summary, including verification and any limitations.") },
    },
    async ({ result }) => ({ content: [{ type: "text", text: JSON.stringify(await requireTeam(host).complete(runId, { result })) }] }),
  );

  mcp.registerTool(
    "team_history",
    {
      description:
        "Read the team conversation's message history, oldest first: who said what to whom, with sequence numbers. Your turn's input already carries what you missed; use this to look further back or to page through a long stretch. Reading history does not change what is delivered to you.",
      inputSchema: {
        after_seq: z.number().int().nonnegative().optional().describe("Return messages after this sequence number."),
        before_seq: z.number().int().positive().optional().describe("Return messages before this sequence number."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size, default 50."),
      },
    },
    async ({ after_seq, before_seq, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await requireTeam(host).history(runId, {
              ...(after_seq !== undefined ? { afterSeq: after_seq } : {}),
              ...(before_seq !== undefined ? { beforeSeq: before_seq } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          ),
        },
      ],
    }),
  );

  mcp.registerTool(
    "team_context",
    {
      description:
        "Read verbatim history that your context handoff stored outside its seed because of size. Pass a stored id from the handoff. Returns the exact original text: a message, or a JSON array of the original entries. Nothing stored was summarized.",
      inputSchema: {
        id: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .describe("A stored id from the context handoff."),
      },
    },
    async ({ id }) => ({ content: [{ type: "text", text: JSON.stringify(await requireTeam(host).context(runId, { id })) }] }),
  );

  return mcp;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileBoundaryUrl } from "@openorc/protocol";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { FileBoundaryAnswer } from "./file-boundary.js";
import { internalToolNames, startMcpServer, type ApprovalRequest, type ApprovalResult, type McpHost } from "./index.js";

type HostCall = { method: string; runId: string; input?: unknown };

async function fixture(t: TestContext) {
  const calls: HostCall[] = [];
  const record = (method: string, runId: string, input?: unknown) => {
    const call = { method, runId, ...(input !== undefined ? { input } : {}) };
    calls.push(call);
    return call;
  };
  const host: McpHost = {
    async approve() {
      return { decision: "deny" };
    },
    async memorySearch() {
      return [];
    },
    async taskContext() {
      return "Fixture context";
    },
    async memoryRecord() {
      return { id: "memory" };
    },
    async memoryFeedback() {},
    tasks: {
      async create(runId, input) {
        record("task.create", runId, input);
        return { task: { id: "task", title: input.title, status: "backlog", branch: null, current: false, resultSummary: null }, duplicate: false, started: false, message: "Saved" };
      },
      async start(runId, id, options) {
        record("task.start", runId, { id, ...options });
        return { id, title: "Saved task", status: "in_progress", branch: null, current: false, resultSummary: null };
      },
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async update() {
        return null;
      },
    },
    execution: {
      available: () => true,
      async context(runId) {
        return record("execution.context", runId);
      },
      async switch(runId, input) {
        return record("execution.switch", runId, input);
      },
    },
    threads: {
      async list() {
        return [];
      },
      async read() {
        return null;
      },
      async send() {
        return { delivered: true, message: "Delivered" };
      },
      async start() {
        return { thread: { id: "started", title: "Assets" }, agent: "codex", model: "fixture-codex", message: "Started" };
      },
    },
  };
  const server = await startMcpServer(host);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
  });
  async function connect(runId: string) {
    const client = new Client({ name: "mcp-contract-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.urlForRun(runId))));
    return client;
  }
  return { calls, host, server, connect };
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok(Array.isArray(result.content));
  const first = result.content[0];
  assert.ok(first && first.type === "text" && typeof first.text === "string");
  return first.text;
}

void test("visualize accepts a self-contained explanation without host actions or echoing its source", async (t) => {
  const { connect, calls } = await fixture(t);
  const client = await connect("visualization-run");
  const tool = (await client.listTools()).tools.find((tool) => tool.name === "visualize");
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.ok(internalToolNames.includes("visualize"));
  const input = { title: "A queue", description: "Items leave in the order they arrive.", html: '<svg aria-label="First in, first out"></svg>' };
  const result = await client.callTool({ name: "visualize", arguments: input });
  assert.ok(!result.isError);
  assert.deepEqual(JSON.parse(resultText(result)), { title: input.title, description: input.description, message: "Visualization added to the conversation." });
  assert.ok(!resultText(result).includes("<svg"));
  assert.deepEqual(calls, []);
  for (const patch of [{ html: " " }, { html: "x".repeat(256_001) }, { description: "" }, { title: "x".repeat(121) }]) {
    assert.equal((await client.callTool({ name: "visualize", arguments: { ...input, ...patch } })).isError, true);
  }
});

/** An MCP initialize request with full control of the headers, as a web page or a stray process would send it. */
function post(target: string, headers: Record<string, string> = {}): Promise<number> {
  const url = new URL(target);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1.0.0" } } });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { host: url.host, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("a run's address works only while its run lives, and only for local agents", async (t) => {
  const { host, server } = await fixture(t);
  const live = new Set(["live-run"]);
  host.live = (runId) => live.has(runId);
  const url = server.urlForRun("live-run");
  assert.equal(await post(url), 200);
  // A web page sends an Origin, and one that rebinds its own name to this address still sends that name as the Host.
  assert.equal(await post(url, { origin: "https://example.com" }), 403);
  assert.equal(await post(url, { host: `attacker.example:${new URL(url).port}` }), 403);
  live.delete("live-run");
  assert.equal(await post(url), 404);
  live.add("live-run");
  server.revoke("live-run");
  assert.equal(await post(url), 404);
  assert.notEqual(server.urlForRun("live-run"), url);
});

test("a run's address answers its Claude file-boundary hook while the run lives", async (t) => {
  const { host, server } = await fixture(t);
  const live = new Set(["plan-run"]);
  host.live = (runId) => live.has(runId);
  const project = mkdtempSync(path.join(tmpdir(), "openorc-hook-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const address = server.urlForRun("plan-run");
  const url = fileBoundaryUrl(address, { root: project, cwd: project, outside: "deny" });
  const hook = async (target: string, request: unknown) => {
    const response = await fetch(target, { method: "POST", body: JSON.stringify(request) });
    return { status: response.status, body: response.ok ? ((await response.json()) as FileBoundaryAnswer) : null };
  };
  assert.deepEqual(await hook(url, { tool_input: { file_path: "notes.md" } }), { status: 200, body: {} });
  const outside = await hook(url, { tool_input: { file_path: "../outside.md" } });
  assert.equal(outside.body?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((await hook(url, { tool_input: {} })).status, 422);
  assert.equal((await hook(`${address}/file-boundary`, { tool_input: { file_path: "notes.md" } })).status, 400);
  live.delete("plan-run");
  assert.equal((await hook(url, { tool_input: { file_path: "notes.md" } })).status, 404);
});

test("browser tools bind identity to the MCP connection and return images as image content", async (t) => {
  const { host, connect } = await fixture(t);
  const calls: unknown[] = [];
  host.browser = async (runId, command) => {
    calls.push({ runId, command });
    return { url: "http://localhost:4321/", title: "Preview", ...(command.action === "screenshot" ? { screenshot: { data: "cG5n", mimeType: "image/png" as const } } : {}) };
  };
  const client = await connect("browser-run");
  const list = await client.listTools();
  assert.ok(list.tools.some((tool) => tool.name === "browser"));
  assert.ok(internalToolNames.includes("browser"));
  assert.notEqual((await client.callTool({ name: "browser", arguments: { action: "open", url: "http://localhost:4321/" } })).isError, true);
  const image = await client.callTool({ name: "browser", arguments: { action: "screenshot" } });
  assert.deepEqual(image.content, [
    { type: "text", text: JSON.stringify({ url: "http://localhost:4321/", title: "Preview" }) },
    { type: "image", data: "cG5n", mimeType: "image/png" },
  ]);
  for (const input of [{ action: "click" }, { action: "snapshot", surface: "thread:other" }, { action: "open", url: "http://localhost", runId: "other" }, { action: "scroll", y: 10001 }]) {
    assert.equal((await client.callTool({ name: "browser", arguments: input })).isError, true);
  }
  assert.deepEqual(calls, [
    { runId: "browser-run", command: { action: "open", url: "http://localhost:4321/" } },
    { runId: "browser-run", command: { action: "screenshot" } },
  ]);
});

// node:test owns the returned promise and reports its failure.
void test("the device tool binds identity to the MCP connection, takes flat input and returns screenshots as images", async (t) => {
  const { host, connect } = await fixture(t);
  const device = { id: "UDID", platform: "ios" as const, name: "iPhone 17 Pro", os: "iOS 26.5", formFactor: "phone" as const, state: "booted" as const };
  const calls: unknown[] = [];
  host.device = async (runId, input) => {
    calls.push({ runId, input });
    if (input.action === "close") throw new Error("No device is open in this conversation.");
    return { action: "screenshot", device, screenshot: { data: "cG5n", mimeType: "image/png" } };
  };
  const client = await connect("device-run");
  const tool = (await client.listTools()).tools.find((item) => item.name === "device");
  assert.deepEqual(Object.keys(tool?.inputSchema.properties ?? {}).sort(), ["action", "deviceId", "platform", "shutdown"]);
  assert.ok(internalToolNames.includes("device"));
  const image = await client.callTool({ name: "device", arguments: { action: "screenshot", deviceId: "UDID" } });
  assert.deepEqual(image.content, [
    { type: "text", text: JSON.stringify({ action: "screenshot", device }) },
    { type: "image", data: "cG5n", mimeType: "image/png" },
  ]);
  const refused = await client.callTool({ name: "device", arguments: { action: "close" } });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /No device is open in this conversation\./);
  assert.equal((await client.callTool({ name: "device", arguments: { action: "list", surface: "thread:other" } })).isError, true);
  assert.deepEqual(calls, [
    { runId: "device-run", input: { action: "screenshot", deviceId: "UDID" } },
    { runId: "device-run", input: { action: "close" } },
  ]);
});

test("browser is absent from hosts without a browser and from read-only task comments", async (t) => {
  const { host, connect } = await fixture(t);
  const client = await connect("comment");
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === "browser"));
  host.browser = async () => ({ url: "", title: "" });
  host.commentTurn = { isComment: () => true, intent: async () => ({}) };
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === "browser"));
});

test("plan_write is offered only where the host accepts a plan document", async (t) => {
  const { host, connect } = await fixture(t);
  const client = await connect("plan-run");
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === "plan_write"));
  const written: unknown[] = [];
  host.plan = { available: (runId) => runId === "plan-run", write: async (runId, text) => void written.push({ runId, text }) };
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "plan_write"));
  assert.ok(internalToolNames.includes("plan_write"));
  assert.notEqual((await client.callTool({ name: "plan_write", arguments: { plan: "# Plan" } })).isError, true);
  assert.equal((await client.callTool({ name: "plan_write", arguments: { plan: "" } })).isError, true);
  assert.deepEqual(written, [{ runId: "plan-run", text: "# Plan" }]);
  assert.ok(!(await (await connect("act-run")).listTools()).tools.some((tool) => tool.name === "plan_write"));
});

void test("pull request review tools exist only for runs reviewing a pull request", async (t) => {
  const { host, connect } = await fixture(t);
  const received: unknown[] = [];
  host.pullReview = {
    available: (runId) => runId === "review-run",
    diff: async (runId, { path, since }) => `diff for ${runId} ${path ?? "all"}${since ? ` since ${since}` : ""}`,
    comment: async (runId, comment) => {
      received.push({ runId, comment });
      return "Draft comment saved.";
    },
    summary: async (runId, body) => {
      received.push({ runId, body });
      return "Summary saved.";
    },
  };
  const names = ["pull_request_diff", "pull_request_comment", "pull_request_summary"];
  for (const name of names) assert.ok(internalToolNames.includes(name));
  const reviewer = await connect("review-run");
  assert.deepEqual(
    (await reviewer.listTools()).tools.map((tool) => tool.name).filter((name) => names.includes(name)),
    names,
  );
  assert.ok(!(await (await connect("other-run")).listTools()).tools.some((tool) => names.includes(tool.name)));

  assert.equal(resultText(await reviewer.callTool({ name: "pull_request_diff", arguments: { path: "src/app.ts" } })), "diff for review-run src/app.ts");
  assert.equal(resultText(await reviewer.callTool({ name: "pull_request_diff", arguments: { since: "abc1234" } })), "diff for review-run all since abc1234");
  assert.equal((await reviewer.callTool({ name: "pull_request_diff", arguments: { since: "HEAD~1" } })).isError, true);
  await reviewer.callTool({ name: "pull_request_comment", arguments: { path: "src/app.ts", line: 12, body: "Close the server." } });
  await reviewer.callTool({ name: "pull_request_comment", arguments: { path: "src/app.ts", line: 12, side: "old", start_line: 10, body: "Keep the guard." } });
  assert.equal((await reviewer.callTool({ name: "pull_request_comment", arguments: { path: "src/app.ts", line: 0, body: "Nowhere." } })).isError, true);
  await reviewer.callTool({ name: "pull_request_summary", arguments: { body: "Nearly there." } });
  assert.deepEqual(received, [
    { runId: "review-run", comment: { path: "src/app.ts", line: 12, side: "new", body: "Close the server." } },
    { runId: "review-run", comment: { path: "src/app.ts", line: 12, side: "old", startLine: 10, startSide: "old", body: "Keep the guard." } },
    { runId: "review-run", body: "Nearly there." },
  ]);
});

void test("an Orcling's own conversation has its own tools instead of the general task, thread and memory tools", async (t) => {
  const { host, connect } = await fixture(t);
  const answer = async () => "";
  host.orcling = {
    available: () => true,
    ownConversation: (runId) => runId === "home-run",
    inChat: (runId) => runId === "home-run" || runId === "group-run",
    updateInstructions: answer,
    remember: answer,
    recall: answer,
    history: answer,
    projects: answer,
    project: answer,
    readThread: answer,
    createTask: answer,
    startWork: answer,
    sendThread: answer,
    react: answer,
    orclings: answer,
    message: answer,
    startGroup: answer,
    activity: answer,
    models: answer,
    usage: answer,
    appMethods: answer,
    app: answer,
  };
  const general = [
    "memory_search",
    "memory_record",
    "memory_feedback",
    "task_context",
    "task_create",
    "task_start",
    "task_list",
    "task_get",
    "task_update",
    "thread_list",
    "thread_read",
    "thread_send",
    "thread_start",
  ];
  const home = (await (await connect("home-run")).listTools()).tools.map((tool) => tool.name);
  const elsewhere = (await (await connect("guest-run")).listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(
    home.filter((name) => general.includes(name)),
    [],
  );
  for (const name of ["ask_user", "orcling_project", "orcling_remember", "orcling_thread_start", "orcling_react", "orcling_orclings", "orcling_message", "orcling_group_start"])
    assert.ok(home.includes(name));
  assert.deepEqual(
    general.filter((name) => elsewhere.includes(name)),
    general,
  );
  // Tapbacks belong to chats, its own or a group's; elsewhere there is no chat to react in.
  assert.ok(!elsewhere.includes("orcling_react"));
  const group = (await (await connect("group-run")).listTools()).tools.map((tool) => tool.name);
  assert.ok(group.includes("orcling_react"));
});

void test("an Orcling starts work on the agent and model it names, or as itself, and names nothing else when it works as itself", async (t) => {
  const { host, connect } = await fixture(t);
  const started: unknown[] = [];
  const answer = async () => "";
  host.orcling = {
    available: () => true,
    ownConversation: () => true,
    inChat: () => true,
    updateInstructions: answer,
    remember: answer,
    recall: answer,
    history: answer,
    projects: answer,
    project: answer,
    readThread: answer,
    createTask: answer,
    startWork: async (_runId, input) => {
      started.push(input);
      return "started";
    },
    sendThread: answer,
    react: answer,
    orclings: answer,
    message: answer,
    startGroup: answer,
    activity: answer,
    models: answer,
    usage: answer,
    appMethods: answer,
    app: answer,
  };
  const client = await connect("home-run");
  const start = (args: Record<string, unknown>) => client.callTool({ name: "orcling_thread_start", arguments: { project_id: "p1", prompt: "Fix it", ...args } });
  await start({ model: "opus 5.5", effort: "extra high", claude_account: "Work", access: "autonomous", report_back: true });
  await start({});
  await start({ yourself: true });
  assert.equal((await start({ yourself: true, model: "gpt-6" })).isError, true);
  assert.deepEqual(started, [
    { projectId: "p1", prompt: "Fix it", worker: { kind: "agent", model: "opus 5.5", effort: "extra high", claudeAccount: "Work" }, access: "autonomous", reportBack: true },
    { projectId: "p1", prompt: "Fix it", worker: { kind: "agent" }, reportBack: false },
    { projectId: "p1", prompt: "Fix it", worker: { kind: "self" }, reportBack: false },
  ]);
});

void test("approval decisions preserve denial, answers and edited tool input across the MCP interface", async (t) => {
  const { host, connect } = await fixture(t);
  const requests: ApprovalRequest[] = [];
  const decisions: ApprovalResult[] = [
    { decision: "deny" },
    { decision: "allow", answers: { "Which path?": ["A", "B"] } },
    { decision: "allow", updatedInput: { path: "reviewed" } },
    { decision: "allow" },
  ];
  host.approve = async (request) => {
    requests.push(request);
    return decisions.shift()!;
  };
  const client = await connect("approval-run");
  const call = async (toolName: string, id: string) =>
    JSON.parse(resultText(await client.callTool({ name: "approve", arguments: { tool_name: toolName, input: { path: "original" }, tool_use_id: id } })));

  assert.deepEqual(await call("Bash", "deny-id"), { behavior: "deny", message: "Denied by the user in OpenOrc." });
  assert.deepEqual(await call("AskUserQuestion", "answers-id"), { behavior: "allow", updatedInput: { path: "original", answers: { "Which path?": "A, B" } } });
  assert.deepEqual(await call("Edit", "edit-id"), { behavior: "allow", updatedInput: { path: "reviewed" } });
  assert.deepEqual(await call("Read", "fallback-id"), { behavior: "allow", updatedInput: { path: "original" } });
  assert.deepEqual(
    requests.map(({ runId, approvalId, toolName }) => ({ runId, approvalId, toolName })),
    [
      { runId: "approval-run", approvalId: "deny-id", toolName: "Bash" },
      { runId: "approval-run", approvalId: "answers-id", toolName: "AskUserQuestion" },
      { runId: "approval-run", approvalId: "edit-id", toolName: "Edit" },
      { runId: "approval-run", approvalId: "fallback-id", toolName: "Read" },
    ],
  );
});

test("disabled memory disappears from discovery without removing task context and can be re-enabled", async (t) => {
  const { connect, host } = await fixture(t);
  let enabled = false;
  host.memoryEnabled = () => enabled;
  const client = await connect("memory-run");
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("task_context"));
  assert.ok(!names.some((name) => name.startsWith("memory_")));
  assert.equal((await client.callTool({ name: "memory_search", arguments: { query: "fixture" } })).isError, true);
  assert.equal(resultText(await client.callTool({ name: "task_context", arguments: {} })), "Fixture context");
  enabled = true;
  assert.equal((await client.listTools()).tools.filter((tool) => tool.name.startsWith("memory_")).length, 3);
  assert.notEqual((await client.callTool({ name: "memory_search", arguments: { query: "fixture" } })).isError, true);
});

test("ordinary task workspace choices cross the MCP boundary and invalid locations never reach the host", async (t) => {
  const { connect, calls } = await fixture(t);
  const client = await connect("workspace-run");
  await client.callTool({ name: "task_create", arguments: { title: "Local task", spec: "Honor the checkout choice", workspace_mode: "current" } });
  await client.callTool({ name: "task_start", arguments: { id: "task", workspace_mode: "worktree" } });
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      { title: "Local task", spec: "Honor the checkout choice", execution: "backlog", workspaceMode: "current" },
      { id: "task", workspaceMode: "worktree" },
    ],
  );
  for (const name of ["task_create", "task_start"]) {
    const invalid = await client.callTool({ name, arguments: { id: "task", title: "Invalid task", spec: "Invalid workspace choice", workspace_mode: "elsewhere" } });
    assert.equal(invalid.isError, true);
  }
  assert.equal(calls.length, 2);
});

test("ask_user advertises a validated schema and returns correlated structured results", async (t) => {
  const { connect, host } = await fixture(t);
  const client = await connect("question-run");
  const listed = (await client.listTools()).tools.find((tool) => tool.name === "ask_user");
  assert.ok(listed?.inputSchema.properties?.questions);
  assert.ok(listed?.outputSchema);
  const seen: string[] = [];
  host.askUser = async (runId, requestId, input) => {
    assert.equal(runId, "question-run");
    assert.equal(input.questions[0]?.question, "Choose a color");
    seen.push(requestId);
    return seen.length === 1 ? { requestId, status: "answered", answers: { color: ["Blue"] } } : { requestId, status: "cancelled" };
  };
  const question = { id: "color", question: " Choose a color ", options: [{ label: "Blue" }] };
  for (const questions of [[], [question, question], [{ ...question, id: "__proto__" }], [{ ...question, question: " " }], [{ ...question, options: [{ label: "Blue" }, { label: "Blue" }] }]]) {
    assert.equal((await client.callTool({ name: "ask_user", arguments: { questions } })).isError, true);
  }
  assert.equal(seen.length, 0);
  const answered = await client.callTool({ name: "ask_user", arguments: { questions: [question] } });
  assert.deepEqual(answered.structuredContent, { requestId: seen[0], status: "answered", answers: { color: ["Blue"] } });
  assert.deepEqual(JSON.parse(resultText(answered)), answered.structuredContent);
  const cancelled = await client.callTool({ name: "ask_user", arguments: { questions: [question] } });
  assert.deepEqual(cancelled.structuredContent, { requestId: seen[1], status: "cancelled" });
  assert.notEqual(seen[0], seen[1]);
});

test("execution tools use the authenticated run and validate switch arguments", { timeout: 10000 }, async (t) => {
  const { connect, calls } = await fixture(t);
  const client = await connect("slack-owner-run");
  const available = (await client.listTools()).tools;
  for (const name of ["execution_context", "execution_switch"]) {
    assert.ok(internalToolNames.includes(name));
    const schema = available.find((tool) => tool.name === name)!.inputSchema;
    for (const forbidden of ["runId", "threadId", "userId", "permissionMode"]) assert.ok(!(forbidden in (schema.properties ?? {})));
  }
  await client.callTool({ name: "execution_context", arguments: { runId: "someone-else" } });
  const input = { agent: "opencode", model: "openrouter/z-ai/glm-5.3", folderId: "folder:demo-app", instructions: "Explain demo-app." };
  const result = await client.callTool({ name: "execution_switch", arguments: { ...input, runId: "someone-else", permissionMode: "trusted" } });
  assert.ok(!result.isError);
  assert.deepEqual(calls, [
    { method: "execution.context", runId: "slack-owner-run" },
    { method: "execution.switch", runId: "slack-owner-run", input },
  ]);
  for (const args of [{ instructions: "Continue" }, { agent: "invalid", instructions: "Continue" }, { model: "glm" }]) {
    assert.equal((await client.callTool({ name: "execution_switch", arguments: args })).isError, true);
  }
  assert.equal(calls.length, 2);
});

test("execution_switch forwards effort-only changes including a reset to default", async (t) => {
  const { connect, calls } = await fixture(t);
  const client = await connect("slack-run");
  for (const effort of ["high", null]) {
    const input = { effort, instructions: "Continue the request" };
    const result = await client.callTool({ name: "execution_switch", arguments: input });
    assert.ok(!result.isError);
    assert.deepEqual(calls.at(-1), { method: "execution.switch", runId: "slack-run", input });
  }
  assert.equal((await client.callTool({ name: "execution_switch", arguments: { effort: "", instructions: "Continue" } })).isError, true);
});

test("removes Teams tools while keeping task and Slack execution tools", async (t) => {
  const { connect } = await fixture(t);
  const client = await connect("ordinary-run");
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("task_create"));
  assert.ok(names.includes("execution_context"));
  assert.ok(names.includes("execution_switch"));
  assert.ok(!names.some((name) => name.startsWith("team_") || name === "task_complete"));
  assert.ok(!internalToolNames.some((name) => name.startsWith("team_") || name === "task_complete"));
});

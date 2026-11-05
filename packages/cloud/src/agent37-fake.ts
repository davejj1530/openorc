import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex, Readable } from "node:stream";
import { promisify } from "node:util";
import type { Agent37CreateParams, Agent37EditParams, Agent37Endpoints, Agent37ExecResult, Agent37Instance, Agent37Status, Agent37Usage } from "./agent37.js";
import { INSTANCE_SERVER_PORT } from "./instance-port.js";

const run = promisify(execFile);
const OUTPUT_LIMIT = 512 * 1024;
const EXEC_BODY_LIMIT = 128 * 1024;
/** Each size and the most disk it takes, in GB, as Agent37 lists them. */
const SIZES = [
  [2, 4, 12],
  [4, 8, 20],
  [4, 16, 40],
  [4, 32, 80],
] as const;
const PORT_PATH = /^\/ports\/([a-z0-9]+)\/(\d+)(\/.*)?$/;
const EXEC_PATH = /^\/sandbox\/v1\/instances\/([a-z0-9]+)\/exec$/;

interface Answer {
  status: number;
  body: unknown;
}

/** One instance as the fake holds it. */
interface Held {
  instance: Agent37Instance;
  env: Record<string, string>;
  /** Where its port INSTANCE_SERVER_PORT listens on this Mac, which its commands find in OPENORC_INSTANCE_PORT. */
  serverPort: number;
  /** The process groups its commands started. */
  groups: Set<number>;
}

export interface FakeAgent37Options {
  /** The environment its commands start from. HOME and OPENORC_INSTANCE_PORT are the instance's own. */
  env?: () => NodeJS.ProcessEnv;
  /** How many instances the account may have; 10 when absent. */
  instanceLimit?: number;
  /** How long a stopped instance takes to start; start answers 202 meanwhile. */
  startMs?: number;
}

export interface FakeAgent37 {
  readonly endpoints: Agent37Endpoints;
  readonly key: string;
  /** Every command the exec API ran, in order. */
  readonly execs: { id: string; command: string; user: string | null; name: string | null }[];
  /** Every hosting API request with the key, as its method and path, in order. */
  readonly requests: string[];
  /** What the usage API reports for an instance. */
  setUsage(id: string, usage: Omit<Agent37Usage, "id">): void;
  /** Makes an instance's addresses answer 502 container_unreachable while what listens inside keeps running. */
  unroute(id: string): void;
  /** Puts an instance in a state no request leads to here, such as failed. */
  setStatus(id: string, status: Agent37Status, reason?: string): void;
  /** Ends every instance's processes and the server. */
  close(): Promise<void>;
}

const ok = (body: unknown, status = 200): Answer => ({ status, body });
/** The hosting API's error shape. */
const refused = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });
/** The error shape of exec and instance addresses. */
const flat = (status: number, code: string): Answer => ({ status, body: { error: code } });

function reply(response: http.ServerResponse, answer: Answer): void {
  response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parse(body: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body.toString("utf8") || "{}");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Kills every process in `groups` and everything they started, as an instance stopping ends all of its processes. */
async function killAll(groups: Set<number>): Promise<void> {
  if (!groups.size) return;
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
  const doomed = new Set(rows.filter(([, , pgid]) => groups.has(pgid)).map(([pid]) => pid));
  for (let grew = true; grew;) {
    const before = doomed.size;
    for (const [pid, ppid] of rows) if (doomed.has(ppid)) doomed.add(pid);
    grew = doomed.size > before;
  }
  groups.clear();
  const signal = (pid: number, name: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  };
  let left = [...doomed].filter((pid) => signal(pid, "SIGKILL"));
  // Wait until they are gone, so the ports they held are free for whatever starts next.
  for (const deadline = Date.now() + 2000; left.length && Date.now() < deadline; left = left.filter((pid) => signal(pid, 0))) await new Promise((resolve) => setTimeout(resolve, 20));
}

function capture(stream: Readable): { text(): string; cut: boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  const state = { cut: false, text: () => Buffer.concat(chunks).toString("utf8") };
  stream.on("data", (chunk: Buffer) => {
    const room = OUTPUT_LIMIT - size;
    if (chunk.length > room) state.cut = true;
    chunks.push(chunk.subarray(0, Math.max(0, room)));
    size += Math.min(chunk.length, Math.max(0, room));
  });
  return state;
}

function invalid(params: Agent37CreateParams): string | null {
  const resources = params.resources;
  const size = resources && SIZES.find(([cpu, memory]) => cpu === resources.cpu && memory === resources.memory);
  if (resources && !size) return "resources must be one of the listed shapes.";
  if (resources && size && (!Number.isInteger(resources.disk) || resources.disk < 2 || resources.disk > size[2]))
    return `Disk for the ${size[0]} vCPU / ${size[1]} GB shape must be a whole number between 2 and ${size[2]} GB.`;
  if (params.idle_timeout_seconds !== undefined && (params.idle_timeout_seconds < 300 || params.idle_timeout_seconds > 86_400)) return "idle_timeout_seconds must be between 300 and 86400.";
  if ((params.name?.length ?? 0) > 60) return "name must be at most 60 characters.";
  return null;
}

/** The account behind the fake: its instances, what they ran, and the API's answers about them. */
class FakeAccount {
  readonly key = `sk_test_${randomBytes(12).toString("hex")}`;
  readonly held = new Map<string, Held>();
  readonly usage = new Map<string, Omit<Agent37Usage, "id">>();
  /** Instances whose addresses do not reach their ports, as when Agent37's routing fails them. */
  readonly unrouted = new Set<string>();
  readonly execs: FakeAgent37["execs"] = [];
  readonly requests: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly options: FakeAgent37Options,
  ) {}

  find(id: string, work: (entry: Held) => Answer | Promise<Answer>): Answer | Promise<Answer> {
    const entry = this.held.get(id);
    return entry ? work(entry) : refused(404, "not_found", "No instance has this id.");
  }

  /** A request or command wakes a sleeping instance; a stopped one stays down until started. */
  awake(entry: Held): boolean {
    if (entry.instance.status === "sleeping") entry.instance.status = "running";
    return entry.instance.status === "running";
  }

  async create(params: Agent37CreateParams): Promise<Answer> {
    const problem = invalid(params);
    if (problem) return refused(400, "invalid_request", problem);
    if (params.region && params.region !== "us") return refused(503, "no_capacity", "No capacity in this region for the default type.");
    if (this.held.size >= (this.options.instanceLimit ?? 10)) return refused(409, "instance_limit_reached", "This account has reached its instance limit.");
    const id = randomBytes(8).toString("hex").slice(0, 10);
    const mount = path.join(this.dir, id);
    await mkdir(mount, { recursive: true });
    const instance: Agent37Instance = {
      id,
      status: "running",
      status_reason: null,
      template: params.template ?? "agent37-base",
      type: "standard",
      region: params.region ?? "us",
      mount_path: mount,
      resources: params.resources ?? { cpu: 2, memory: 4, disk: 20 },
      url: `https://${id}.agent37.app`,
      public_ports: (params.public_ports ?? []).map((port) => ({ ...port, url: `https://${id}-${port.port}.agent37.app` })),
      name: params.name ?? null,
      metadata: params.metadata ?? {},
      auto_sleep: params.auto_sleep ?? true,
      idle_timeout_seconds: params.idle_timeout_seconds ?? 900,
      network: null,
      slept_at: null,
      past_due: false,
      created: Math.floor(Date.now() / 1000),
    };
    this.held.set(id, { instance, env: { ...params.env }, serverPort: await freePort(), groups: new Set() });
    return ok(instance, 201);
  }

  edit(entry: Held, params: Agent37EditParams): Answer {
    const { instance } = entry;
    if (params.idle_timeout_seconds !== undefined && invalid({ idle_timeout_seconds: params.idle_timeout_seconds }))
      return refused(400, "invalid_request", "idle_timeout_seconds must be between 300 and 86400.");
    for (const [name, value] of Object.entries(params.env ?? {})) {
      if (value === null) delete entry.env[name];
      else entry.env[name] = value;
    }
    Object.assign(instance, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      ...(params.auto_sleep !== undefined ? { auto_sleep: params.auto_sleep } : {}),
      ...(params.idle_timeout_seconds !== undefined ? { idle_timeout_seconds: params.idle_timeout_seconds } : {}),
    });
    return ok(instance);
  }

  async remove(entry: Held): Promise<Answer> {
    await killAll(entry.groups);
    this.held.delete(entry.instance.id);
    await rm(entry.instance.mount_path, { recursive: true, force: true });
    return ok({ id: entry.instance.id, deleted: true });
  }

  addPublicPort(entry: Held, body: Record<string, unknown>): Answer {
    const { instance } = entry;
    if (typeof body.port !== "number" || !Number.isInteger(body.port)) return refused(400, "invalid_request", "port must be an integer.");
    if (instance.public_ports.some((open) => open.port === body.port)) return refused(409, "public_port_exists", "This port is public already.");
    const opened = { port: body.port, url: `https://${instance.id}-${body.port}.agent37.app`, prefix: null, label: typeof body.label === "string" ? body.label : null };
    instance.public_ports.push(opened);
    return ok(opened, 201);
  }

  start(entry: Held): Answer {
    const { instance } = entry;
    if (!this.options.startMs) {
      instance.status = "running";
      return ok({ id: instance.id, status: "running" });
    }
    instance.status = "starting";
    setTimeout(() => (instance.status = "running"), this.options.startMs).unref();
    return ok({ id: instance.id, status: "starting" }, 202);
  }

  async down(entry: Held, status: "stopped" | "sleeping"): Promise<Answer> {
    await killAll(entry.groups);
    entry.instance.status = status;
    if (status === "sleeping") entry.instance.slept_at = Math.floor(Date.now() / 1000);
    return ok({ id: entry.instance.id, status });
  }

  spending(url: URL): Answer {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(url.searchParams.get("from") ?? "") || !day.test(url.searchParams.get("to") ?? "")) return refused(400, "invalid_request", "from and to must be YYYY-MM-DD.");
    return ok({ instances: [...this.usage].map(([id, spent]) => ({ id, ...spent })) });
  }

  async exec(entry: Held, command: string): Promise<Agent37ExecResult> {
    const mount = entry.instance.mount_path;
    const env = { ...(this.options.env?.() ?? process.env), ...entry.env, HOME: mount, PWD: mount, OPENORC_INSTANCE_PORT: String(entry.serverPort) };
    const child = spawn("sh", ["-c", command], { cwd: mount, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) entry.groups.add(child.pid);
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    return { exit_code: code ?? 128 + (signal ? os.constants.signals[signal] : 0), stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.cut || stderr.cut };
  }

  async serveExec(request: http.IncomingMessage, url: URL, body: Buffer): Promise<Answer> {
    if (request.headers["x-agent37-key"] !== this.key) return flat(401, "unauthorized");
    const match = EXEC_PATH.exec(url.pathname);
    if (!match || request.method !== "POST") return flat(404, "not_found");
    if (body.length > EXEC_BODY_LIMIT) return flat(413, "request_too_large");
    const entry = this.held.get(match[1]!);
    if (!entry) return flat(404, "not_found");
    const params = parse(body);
    if (typeof params.command !== "string") return flat(400, "invalid_request");
    if (!this.awake(entry)) return flat(409, "instance_not_running");
    this.execs.push({ id: entry.instance.id, command: params.command, user: typeof params.user === "string" ? params.user : null, name: typeof params.name === "string" ? params.name : null });
    return ok(await this.exec(entry, params.command));
  }

  async serveHosting(request: http.IncomingMessage, url: URL, body: Buffer): Promise<Answer> {
    if (request.headers.authorization !== `Bearer ${this.key}`) return refused(401, "unauthorized", "The API key is missing or wrong.");
    this.requests.push(`${request.method} ${url.pathname}`);
    for (const [method, pattern, work] of HOSTING) {
      const match = pattern.exec(url.pathname);
      if (match && method === request.method) return work(this, match[1] ?? "", parse(body), url);
    }
    return refused(404, "not_found", "No such route.");
  }

  /** Where a request to an instance's address goes on this Mac, or why it does not. A public port needs no key. */
  target(request: http.IncomingMessage, match: RegExpExecArray): number | Answer {
    const entry = this.held.get(match[1]!);
    const port = Number(match[2]);
    const open = entry?.instance.public_ports.some((each) => each.port === port);
    if (!open && request.headers["x-agent37-key"] !== this.key) return flat(401, "invalid_api_key");
    if (!entry) return flat(404, "not_found");
    if (!this.awake(entry)) return flat(502, "container_unavailable");
    if (this.unrouted.has(entry.instance.id)) return flat(502, "container_unreachable");
    return port === INSTANCE_SERVER_PORT ? entry.serverPort : port;
  }
}

const HOSTING: [string, RegExp, (account: FakeAccount, id: string, body: Record<string, unknown>, url: URL) => Answer | Promise<Answer>][] = [
  ["POST", /^\/v1\/instances$/, (account, _id, body) => account.create(body as Agent37CreateParams)],
  ["GET", /^\/v1\/instances$/, (account) => ok({ data: [...account.held.values()].reverse().map((entry) => entry.instance) })],
  ["GET", /^\/v1\/instances\/(\w+)$/, (account, id) => account.find(id, (entry) => ok(entry.instance))],
  ["PATCH", /^\/v1\/instances\/(\w+)$/, (account, id, body) => account.find(id, (entry) => account.edit(entry, body as Agent37EditParams))],
  ["DELETE", /^\/v1\/instances\/(\w+)$/, (account, id) => account.find(id, (entry) => account.remove(entry))],
  ["POST", /^\/v1\/instances\/(\w+)\/public-ports$/, (account, id, body) => account.find(id, (entry) => account.addPublicPort(entry, body))],
  ["POST", /^\/v1\/instances\/(\w+)\/start$/, (account, id) => account.find(id, (entry) => account.start(entry))],
  ["POST", /^\/v1\/instances\/(\w+)\/stop$/, (account, id) => account.find(id, (entry) => account.down(entry, "stopped"))],
  ["POST", /^\/v1\/instances\/(\w+)\/sleep$/, (account, id) => account.find(id, (entry) => account.down(entry, "sleeping"))],
  ["GET", /^\/v1\/usage$/, (account, _id, _body, url) => account.spending(url)],
];

function proxy(account: FakeAccount, request: http.IncomingMessage, response: http.ServerResponse, match: RegExpExecArray, search: string): void {
  const port = account.target(request, match);
  if (typeof port !== "number") return reply(response, port);
  // As Agent37's own edge does: an instance address answers /health itself, whatever listens on the port.
  if ((match[3] ?? "/") === "/health") return reply(response, ok({ ok: true }));
  const headers = { ...request.headers };
  delete headers["x-agent37-key"];
  const upstream = http.request({ host: "127.0.0.1", port, method: request.method, path: `${match[3] ?? "/"}${search}`, headers, agent: false }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  upstream.on("error", () => (response.headersSent ? response.destroy() : reply(response, flat(502, "container_unreachable"))));
  request.pipe(upstream);
}

/** Passes a WebSocket through to the instance's port as is, minus the key. */
function proxyUpgrade(account: FakeAccount, upgraded: Set<Duplex>, request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? "/", "http://fake");
  const match = PORT_PATH.exec(url.pathname);
  const refuse = (answer: Answer) =>
    socket.end(`HTTP/1.1 ${answer.status} ${http.STATUS_CODES[answer.status]}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify(answer.body)}`);
  if (!match) return void refuse(flat(404, "not_found"));
  const port = account.target(request, match);
  if (typeof port !== "number") return void refuse(port);
  const upstream = net.connect(port, "127.0.0.1");
  upgraded.add(socket).add(upstream);
  socket.on("close", () => {
    upgraded.delete(socket);
    upstream.destroy();
  });
  upstream.on("close", () => {
    upgraded.delete(upstream);
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => (upstream.connecting ? refuse(flat(502, "bad_gateway")) : socket.destroy()));
  upstream.once("connect", () => {
    const lines = [`${request.method} ${match[3] ?? "/"}${url.search} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() !== "x-agent37-key") lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
}

/**
 * Agent37 on this Mac, for tests: its hosting API with the real error shapes, exec as a local `sh -c` in the
 * instance's folder, and instance addresses that check the key and pass HTTP and WebSocket to the instance's port.
 * Each instance's folder under `dir` is its home, and its commands are local processes it kills when it stops.
 */
export async function startFakeAgent37(dir: string, options: FakeAgent37Options = {}): Promise<FakeAgent37> {
  const account = new FakeAccount(dir, options);
  const upgraded = new Set<Duplex>();
  const serve = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://fake");
    const port = PORT_PATH.exec(url.pathname);
    if (port) return proxy(account, request, response, port, url.search);
    const body = await readBody(request);
    reply(response, await (url.pathname.startsWith("/sandbox/") ? account.serveExec(request, url, body) : account.serveHosting(request, url, body)));
  };
  const server = http.createServer((request, response) => {
    serve(request, response).catch((error: unknown) => reply(response, flat(500, error instanceof Error ? error.message : "internal")));
  });
  server.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => proxyUpgrade(account, upgraded, request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoints: { api: `${base}/v1`, sandbox: `${base}/sandbox`, instance: (id, port) => `${base}/ports/${id}/${port}` },
    key: account.key,
    execs: account.execs,
    requests: account.requests,
    setUsage: (id, spent) => void account.usage.set(id, spent),
    unroute: (id) => void account.unrouted.add(id),
    setStatus: (id, status, reason) => {
      const entry = account.held.get(id);
      if (entry) Object.assign(entry.instance, { status, status_reason: reason ? { code: status, message: reason } : null });
    },
    close: async () => {
      await Promise.all([...account.held.values()].map((entry) => killAll(entry.groups)));
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Agent37's instances API (agent37.com/docs/agents-api, read 2026-11-05), as plain HTTPS. */

export type Agent37Status = "provisioning" | "running" | "stopping" | "stopped" | "starting" | "restarting" | "updating" | "sleeping" | "waking" | "failed" | "deleting" | "deleted";

/** CPUs, GB of memory and GB of disk. */
export interface Agent37Resources {
  cpu: number;
  memory: number;
  disk: number;
}

/** An instance as the API returns it. */
export interface Agent37Instance {
  /** Ten lowercase letters and digits. */
  id: string;
  status: Agent37Status;
  /** Why it is in its state, when Agent37 says. */
  status_reason: { code: string; message: string } | null;
  template: string;
  /** Such as `default`; the docs list `vm` among the types an instance is made as, but not among those it reports. */
  type: string;
  region: string;
  /** The default user's home, where its files live, such as /home/node. */
  mount_path: string;
  resources: Agent37Resources;
  url: string;
  public_ports: Agent37PublicPort[];
  name: string | null;
  metadata: Record<string, string> | null;
  auto_sleep: boolean;
  idle_timeout_seconds: number;
  network: unknown;
  slept_at?: number | null;
  past_due: boolean;
  /** Epoch seconds. */
  created: number;
}

/** A port anyone can reach at `url`, with no key. */
export interface Agent37PublicPort {
  port: number;
  url: string;
  prefix?: string | null;
  label?: string | null;
}

/**
 * What an instance runs on, fixed for its life: `default` is a sandbox under gVisor, which cannot run a Docker daemon;
 * `vm` is a whole VM with its own kernel, whose compute bills at 2.5 times the default rate.
 */
export type Agent37Type = "default" | "vm";

export interface Agent37CreateParams {
  template?: string;
  type?: Agent37Type;
  resources?: Agent37Resources;
  region?: "us" | "eu" | "ap-south";
  name?: string;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  public_ports?: { port: number; prefix?: string; label?: string }[];
}

export interface Agent37EditParams {
  name?: string;
  metadata?: Record<string, string>;
  /** A null value unsets the variable. */
  env?: Record<string, string | null>;
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  network?: unknown;
}

export interface Agent37ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Either output passed 512 KB and was cut there. */
  truncated: boolean;
}

/** One instance's spending over a usage window, in millionths of a dollar. */
export interface Agent37Usage {
  id: string;
  total_micros: number;
  compute_micros: number;
}

/** Where one port of an instance answers, and the headers that let a request through. */
export interface PortAddress {
  url: string;
  headers: Record<string, string>;
}

export interface Agent37Endpoints {
  /** The hosting API, ending in /v1. */
  api: string;
  /** Where commands run. */
  sandbox: string;
  /** The address of `port` on the instance. */
  instance(id: string, port: number): string;
}

export const AGENT37_ENDPOINTS: Agent37Endpoints = {
  api: "https://api.agent37.com/v1",
  sandbox: "https://sandbox.agent37.app",
  instance: (id, port) => `https://${id}-${port}.agent37.app`,
};

/** How OpenOrc reaches Agent37 with one key. Tests pass a stand-in; the app passes `agent37Api`. */
export interface Agent37Api {
  /** Answers once the instance runs. */
  create(params: Agent37CreateParams): Promise<Agent37Instance>;
  /** Every instance on the account, newest first. */
  list(): Promise<Agent37Instance[]>;
  /** Null when there is no such instance. */
  get(id: string): Promise<Agent37Instance | null>;
  edit(id: string, params: Agent37EditParams): Promise<Agent37Instance>;
  /** Deletes the instance and its disk. Done when it is already gone. */
  remove(id: string): Promise<void>;
  /** Gives `port` a URL anyone can reach with no key. Refused with `public_port_exists` when it has one. */
  addPublicPort(id: string, port: number, label?: string): Promise<Agent37PublicPort>;
  /** Answers once the instance runs. */
  start(id: string): Promise<void>;
  /** Ends its processes and boots it again, which runs its boot hooks; answers once it runs. */
  restart(id: string): Promise<void>;
  /** Ends its processes; the disk stays, and it stays down until started. */
  stop(id: string): Promise<void>;
  /** Keeps memory and processes; the next request or command wakes it. */
  sleep(id: string): Promise<void>;
  /** Runs `command` with sh -c to completion, as the default user unless `root`. */
  exec(id: string, command: string, options?: { root?: boolean; name?: string }): Promise<Agent37ExecResult>;
  /** Spending per instance between two days, YYYY-MM-DD, at most 90 days apart. */
  usage(from: string, to: string): Promise<Agent37Usage[]>;
  port(id: string, port: number): PortAddress;
}

/** What Agent37 refused, in words where the reason is one a person can act on. */
const REFUSALS: Record<string, string> = {
  insufficient_balance: "Your Agent37 balance is too low for this. Add funds at agent37.com.",
  instance_limit_reached: "Your Agent37 account has as many instances as it may have. Delete one, or add funds to raise the limit.",
  no_capacity: "Agent37 has no room for an instance of this size right now. Try a smaller size, or again later.",
  try_again: "The command ran longer than Agent37 waits for one.",
};

/** A refusal from Agent37, from either of its error shapes. */
export class Agent37Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Agent37Error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function refusal(status: number, code: string, message?: string): Agent37Error {
  if (status === 401 || status === 403) return new Agent37Error(status, code, "Agent37 did not accept this key.");
  return new Agent37Error(status, code, REFUSALS[code] ?? message ?? `Agent37 answered ${status} (${code}).`);
}

/** The hosting API nests its errors as { error: { code, message } }; instance addresses answer { error: "code" }. */
export function agent37Error(status: number, body: unknown): Agent37Error {
  const error = isRecord(body) ? body.error : undefined;
  if (typeof error === "string") return refusal(status, error);
  if (isRecord(error) && typeof error.code === "string") return refusal(status, error.code, typeof error.message === "string" ? error.message : undefined);
  return refusal(status, `http_${status}`);
}

const START_POLL_MS = 500;
const START_TIMEOUT_MS = 5 * 60_000;

export function agent37Api(key: string, endpoints: Agent37Endpoints = AGENT37_ENDPOINTS, request: typeof fetch = fetch): Agent37Api {
  const send = async <T>(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await request(url, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A proxy's HTML error page; the status says enough.
    }
    if (!response.ok) throw agent37Error(response.status, parsed);
    return { status: response.status, body: parsed as T };
  };
  const hosting = async <T>(method: string, path: string, body?: unknown) => (await send<T>(method, `${endpoints.api}${path}`, { authorization: `Bearer ${key}` }, body)).body;
  const missing = <T>(error: unknown, value: T): T => {
    if (error instanceof Agent37Error && error.status === 404) return value;
    throw error;
  };
  /** Waits for the instance to run, as after a start or a restart. */
  const running = async (id: string): Promise<void> => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const instance = await api.get(id);
      if (instance?.status === "running") return;
      if (!instance || instance.status === "failed") throw new Error(`The Agent37 instance did not start${instance?.status_reason ? `: ${instance.status_reason.message}` : "."}`);
      if (Date.now() > deadline) throw new Error(`The Agent37 instance was still ${instance.status} after ${START_TIMEOUT_MS / 60_000} minutes.`);
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
  };
  const api: Agent37Api = {
    create: (params) => hosting("POST", "/instances", params),
    list: async () => (await hosting<{ data: Agent37Instance[] }>("GET", "/instances")).data,
    get: (id) => hosting<Agent37Instance>("GET", `/instances/${id}`).catch((error: unknown) => missing(error, null)),
    edit: (id, params) => hosting("PATCH", `/instances/${id}`, params),
    remove: async (id) => {
      await hosting("DELETE", `/instances/${id}`).catch((error: unknown) => missing(error, null));
    },
    addPublicPort: (id, port, label) => hosting("POST", `/instances/${id}/public-ports`, { port, ...(label ? { label } : {}) }),
    start: async (id) => {
      const started = await send<{ status?: string }>("POST", `${endpoints.api}/instances/${id}/start`, { authorization: `Bearer ${key}` });
      if (started.status === 200 && started.body?.status === "running") return;
      // 202: still starting.
      await running(id);
    },
    restart: async (id) => {
      await hosting("POST", `/instances/${id}/restart`);
      await running(id);
    },
    stop: async (id) => {
      await hosting("POST", `/instances/${id}/stop`);
    },
    sleep: async (id) => {
      await hosting("POST", `/instances/${id}/sleep`);
    },
    exec: async (id, command, options = {}) =>
      (
        await send<Agent37ExecResult>(
          "POST",
          `${endpoints.sandbox}/v1/instances/${id}/exec`,
          { "x-agent37-key": key },
          {
            command,
            ...(options.root ? { user: "root" } : {}),
            ...(options.name ? { name: options.name } : {}),
          },
        )
      ).body,
    usage: async (from, to) => (await hosting<{ instances: Agent37Usage[] }>("GET", `/usage?from=${from}&to=${to}`)).instances,
    port: (id, port) => ({ url: endpoints.instance(id, port), headers: { "x-agent37-key": key } }),
  };
  return api;
}

/** Agent37's list prices per 730-hour month (agent37.com/pricing, 2026-11-05). */
const PRICE = { vcpu: 0.8, memoryGb: 0.7, diskGb: 0.09, monthHours: 730 } as const;
/** How many times the default rate each type's compute bills at (agent37.com/docs/agents-api/vm-instances, 2026-11-06). */
const COMPUTE_RATE: Record<Agent37Type, number> = { default: 1, vm: 2.5 };
const HOUR_MS = 3_600_000;

/** Dollars an hour for an instance of this size and type: compute while it runs, disk whatever its state. */
export function agent37Hourly(resources: Agent37Resources, type: Agent37Type = "default"): { compute: number; disk: number } {
  return {
    compute: ((resources.cpu * PRICE.vcpu + resources.memory * PRICE.memoryGb) * COMPUTE_RATE[type]) / PRICE.monthHours,
    disk: (resources.disk * PRICE.diskGb) / PRICE.monthHours,
  };
}

/** What an instance of this size costs to run for `ms`, its disk included. */
export function agent37Cost(resources: Agent37Resources, ms: number): number {
  const hourly = agent37Hourly(resources);
  return ((hourly.compute + hourly.disk) * ms) / HOUR_MS;
}

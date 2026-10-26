import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DeviceHelpers } from "@openorc/protocol";
import { writePrivateFile } from "./files.js";
import { commandLine, stopChild, terminate, type ChildHandle, type DeviceSystem, type ProcessEnv } from "./system.js";

/** How to start the hub: the user's node, the installed CLI and the environment it runs with. */
export interface HubLaunch {
  node: string;
  entry: string;
  env: ProcessEnv;
}

interface LiveHub {
  child: ChildHandle;
  port: number;
  token: string;
  startedAt: number;
  /** iOS stream attaches made on this hub instance, by UDID. A restarted hub starts with none. */
  attached: Map<string, Promise<void>>;
  events: WebSocket | null;
}

/**
 * The hub's lifecycle. `restarting` waits out a backoff after an unexpected exit, then spawns again; `failed` is a
 * start the user asked for that did not come up, and waits for the next request.
 */
type HubState =
  | { phase: "off" }
  | { phase: "starting"; ready: Promise<LiveHub> }
  | { phase: "running"; hub: LiveHub }
  | { phase: "restarting"; error: string; ready: Promise<LiveHub>; cancel: AbortController }
  | { phase: "failed"; error: string };

export interface HubOptions {
  /** EXPO_DEVICE_HUB_STATE_DIR. The hub writes `server-<port>.json` with its token here. */
  stateDir: string;
  /** Our own record of the hub we started, for reaping one a crashed core left behind. */
  recordPath: string;
  system: DeviceSystem;
  /** The lifecycle phase changed. */
  changed(): void;
  /** The hub reported a device list change. */
  devicesChanged(): void;
  debug(line: string): void;
}

/** Node's WebSocket takes upgrade headers in its init. The DOM typing the desktop build also compiles against does not know that. */
type NodeWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;
const ATTACH_TIMEOUT_MS = 3 * 60_000;

/** The next restart delay: doubling from 1 s to 30 s, back to 1 s after a hub that stayed up a minute. */
export function nextBackoff(previous: number, uptimeMs: number): number {
  if (!previous || uptimeMs >= STABLE_UPTIME_MS) return FIRST_BACKOFF_MS;
  return Math.min(previous * 2, MAX_BACKOFF_MS);
}

/**
 * The expo-device-hub child process: started on loopback with a random token only the core holds, restarted with
 * backoff when it exits on its own, and stopped with the device support it serves. Simulators and emulators are not
 * the hub's to keep: stopping it leaves every device running.
 */
export class HubSupervisor {
  private state: HubState = { phase: "off" };
  private launch: HubLaunch | null = null;
  private backoff = 0;

  constructor(private readonly options: HubOptions) {}

  helpers(): DeviceHelpers {
    const { state } = this;
    if (state.phase === "restarting" || state.phase === "failed") return { phase: state.phase, error: state.error };
    return { phase: state.phase };
  }

  get running(): boolean {
    return this.state.phase === "running";
  }

  /** Resolves once the hub answers. Joins a start or restart already under way. */
  async start(launch: HubLaunch): Promise<void> {
    const { state } = this;
    if (state.phase === "running") return;
    if (state.phase === "starting" || state.phase === "restarting") {
      await state.ready;
      return;
    }
    this.launch = launch;
    this.backoff = 0;
    const ready = this.spawnHub(launch);
    this.setState({ phase: "starting", ready });
    try {
      const hub = await ready;
      if (this.state.phase === "starting" && this.state.ready === ready) this.setRunning(hub);
    } catch (error) {
      if (this.state.phase === "starting" && this.state.ready === ready) this.setState({ phase: "failed", error: errorMessage(error) });
      throw error;
    }
  }

  /** Stops the hub and any restart in flight. Idempotent. */
  async stop(): Promise<void> {
    const { state } = this;
    this.setState({ phase: "off" });
    if (state.phase === "restarting") state.cancel.abort();
    if (state.phase === "running") await this.halt(state.hub);
    if (state.phase === "starting" || state.phase === "restarting")
      await state.ready.then(
        (hub) => this.halt(hub),
        () => undefined,
      );
    await rm(this.options.recordPath, { force: true });
  }

  /** Stops a hub a previous core left running: only when its pid still runs our hub's entry file. */
  async reapStale(): Promise<void> {
    const record = await readRecord(this.options.recordPath);
    if (record && (await commandLine(this.options.system, record.pid)).includes(record.entryPath)) {
      this.options.debug(`stopping a device hub left behind by an earlier run (pid ${record.pid})`);
      await terminate(this.options.system, record.pid);
    }
    await rm(this.options.recordPath, { force: true });
  }

  /** A request to the hub with its token. Waits for a start under way. */
  async request(route: string, init: RequestInit = {}): Promise<Response> {
    const hub = await this.connection();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${hub.token}`);
    return fetch(`http://127.0.0.1:${hub.port}${route}`, { ...init, headers });
  }

  /** A WebSocket to the hub with its token in the upgrade request. */
  async socket(route: string): Promise<WebSocket> {
    return this.open(await this.connection(), route);
  }

  /**
   * Attaches serve-sim's capture to a booted simulator. Idempotent per hub instance, so opening a stream does not
   * attach again; `fresh` attaches anyway, for a simulator that has just booted.
   */
  async ensureAttached(udid: string, fresh = false): Promise<void> {
    const hub = await this.connection();
    const known = fresh ? undefined : hub.attached.get(udid);
    if (known) return known;
    const attach = this.attach(hub, udid);
    hub.attached.set(udid, attach);
    attach.catch(() => {
      if (hub.attached.get(udid) === attach) hub.attached.delete(udid);
    });
    return attach;
  }

  isAttached(udid: string): boolean {
    return this.state.phase === "running" && this.state.hub.attached.has(udid);
  }

  forgetAttached(udid: string): void {
    if (this.state.phase === "running") this.state.hub.attached.delete(udid);
  }

  private async connection(): Promise<LiveHub> {
    const { state } = this;
    if (state.phase === "running") return state.hub;
    if (state.phase === "starting" || state.phase === "restarting") return state.ready;
    throw new Error("The device hub is not running.");
  }

  private async attach(hub: LiveHub, udid: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${hub.port}/vendor/serve-sim/grid/api/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ udid }),
      signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (!response.ok || body?.ok !== true) throw new Error("The simulator's screen could not be attached.");
  }

  private open(hub: LiveHub, route: string): WebSocket {
    const socket = new (WebSocket as unknown as NodeWebSocket)(`ws://127.0.0.1:${hub.port}${route}`, { headers: { Authorization: `Bearer ${hub.token}` } });
    socket.binaryType = "arraybuffer";
    return socket;
  }

  private setState(state: HubState): void {
    this.state = state;
    this.options.changed();
  }

  private setRunning(hub: LiveHub): void {
    this.setState({ phase: "running", hub });
    this.subscribe(hub);
    void hub.child.exited.then((exit) => this.exited(hub, exit.code));
  }

  private exited(hub: LiveHub, code: number | null): void {
    if (this.state.phase !== "running" || this.state.hub !== hub) return;
    const events = hub.events;
    hub.events = null;
    events?.close();
    this.backoff = nextBackoff(this.backoff, this.options.system.now() - hub.startedAt);
    this.restart(code === null ? "The device hub stopped unexpectedly." : `The device hub exited with code ${code}.`);
  }

  /**
   * One attempt: wait out the backoff, then spawn. A failed attempt schedules the next with a longer wait, so a caller
   * that joined it hears that attempt's failure instead of waiting through every retry.
   */
  private restart(error: string): void {
    const cancel = new AbortController();
    const launch = this.launch!;
    // The wait starts on the next microtask, so the state already says restarting when it begins.
    const ready = Promise.resolve().then(async () => {
      this.options.debug(`restarting the device hub in ${this.backoff} ms`);
      await this.options.system.delay(this.backoff, cancel.signal);
      if (cancel.signal.aborted) throw new Error("The device hub was stopped.");
      return this.spawnHub(launch);
    });
    this.setState({ phase: "restarting", error, ready, cancel });
    const current = () => this.state.phase === "restarting" && this.state.cancel === cancel;
    ready.then(
      (hub) => {
        if (current()) this.setRunning(hub);
      },
      (failure: unknown) => {
        if (!current()) return;
        this.backoff = nextBackoff(this.backoff, 0);
        this.restart(errorMessage(failure));
      },
    );
  }

  private async halt(hub: LiveHub): Promise<void> {
    const events = hub.events;
    hub.events = null;
    events?.close();
    await stopChild(this.options.system, hub.child);
  }

  private async spawnHub(launch: HubLaunch): Promise<LiveHub> {
    const { system, stateDir } = this.options;
    await this.reapStale();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = await system.reservePort();
    await rm(path.join(stateDir, `server-${port}.json`), { force: true });
    const args = [launch.entry, "--port", String(port), "--host", "127.0.0.1", "--require-token", "--hide-sidebar", "--hide-boot-device"];
    // Only a Mac lists Apple simulators; elsewhere the hub's attempt would only surface as an error.
    if (system.platform !== "darwin") args.push("--platform", "android");
    const child = system.spawn(launch.node, args, {
      env: { ...launch.env, EXPO_DEVICE_HUB_STATE_DIR: stateDir, FORCE_COLOR: "0", NO_COLOR: "1" },
      // The hub prints a link that carries its token; only the core may hold it.
      onOutput: (line) => this.options.debug(line.replace(/token=[^\s&#]+/g, "token=[hidden]")),
    });
    try {
      const token = await this.awaitReady(child, port);
      await writePrivateFile(this.options.recordPath, JSON.stringify({ pid: child.pid, port, entryPath: launch.entry }));
      return { child, port, token, startedAt: system.now(), attached: new Map(), events: null };
    } catch (error) {
      await stopChild(system, child);
      throw error;
    }
  }

  /** Ready means `/readyz` answers and the hub has published the token for this port and pid. */
  private async awaitReady(child: ChildHandle, port: number): Promise<string> {
    const { system } = this.options;
    let exited = false;
    void child.exited.then(() => (exited = true));
    const deadline = system.now() + READY_TIMEOUT_MS;
    while (system.now() < deadline) {
      if (exited) throw new Error("The device hub exited while starting.");
      const token = await this.publishedToken(port, child.pid);
      if (token && (await answers(port))) return token;
      await system.delay(READY_POLL_MS);
    }
    throw new Error("The device hub did not start within 30 seconds.");
  }

  private async publishedToken(port: number, pid: number): Promise<string | null> {
    const raw = await readFile(path.join(this.options.stateDir, `server-${port}.json`), "utf8").catch(() => null);
    const state = raw ? (parseJson(raw) as { pid?: unknown; token?: unknown } | null) : null;
    return state?.pid === pid && typeof state.token === "string" && state.token ? state.token : null;
  }

  private subscribe(hub: LiveHub): void {
    const socket = this.open(hub, "/api/devices/ws");
    hub.events = socket;
    socket.addEventListener("message", (event) => {
      if (!isHeartbeat(event.data)) this.options.devicesChanged();
    });
    socket.addEventListener("close", () => {
      if (hub.events !== socket) return;
      hub.events = null;
      void this.options.system.delay(FIRST_BACKOFF_MS).then(() => {
        if (this.state.phase === "running" && this.state.hub === hub && !hub.events) this.subscribe(hub);
      });
    });
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function isHeartbeat(data: unknown): boolean {
  if (typeof data !== "string") return false;
  return (parseJson(data) as { type?: unknown } | null)?.type === "heartbeat";
}

async function readRecord(file: string): Promise<{ pid: number; entryPath: string } | null> {
  const raw = await readFile(file, "utf8").catch(() => null);
  const record = raw ? (parseJson(raw) as { pid?: unknown; entryPath?: unknown } | null) : null;
  return typeof record?.pid === "number" && typeof record.entryPath === "string" && record.entryPath ? { pid: record.pid, entryPath: record.entryPath } : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

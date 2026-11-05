import { BrainMachine, brainDoor, ticketStanding, vercelDenied, type DoorConfig, type WakeResult } from "@openorc/cloud/door";
import { doorLine, knockInWindow, knockProves, readKnock, type DoorOutcome, type DoorRefusalReason } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";

/**
 * The brain's door: the function in the person's Vercel team a paired phone knocks on to wake the brain. GET answers
 * with the config's mark, so the Mac can tell the door is current; POST takes a knock. A refused knock costs one HMAC
 * and wakes nothing; an accepted one streams `accepted`, a blank line every 10 s, then `done`.
 */
export interface DoorDeps {
  /** From the door's env when the instance started; null for a door without one. */
  config: DoorConfig | null;
  /** The door's only reach into Vercel. It never installs a brain: only the Mac does. Never throws. */
  wake(config: DoorConfig): Promise<DoorOutcome>;
  now(): number;
  /** Vercel's waitUntil: the wake runs to its end when the phone has gone. */
  waitUntil(work: Promise<unknown>): void;
  log(line: string): void;
  keepaliveMs?: number;
}

const KEEPALIVE_MS = 10_000;
const MAX_BODY = 4096;
const HEADERS = { "content-type": "application/x-ndjson", "cache-control": "no-store" };

type Admission = { kind: "unreadable" } | { kind: "refused"; why: DoorRefusalReason } | { kind: "admitted"; config: DoorConfig; device: string };

/** Every check before anything costs: the body, the version, the config, the revoked list, the clock, the proof, the epoch. */
function admit(config: DoorConfig | null, body: unknown, now: number): Admission {
  const read = readKnock(body);
  if (read.kind === "unreadable") return read;
  if (read.kind === "newer") return { kind: "refused", why: "door-outdated" };
  if (!config) return { kind: "refused", why: "needs-mac" };
  const { knock } = read;
  const standing = ticketStanding(knock.epoch, now);
  const door = brainDoor(config.key);
  if (config.revoked.includes(knock.device) || !knockInWindow(knock, now) || standing === "ahead") return { kind: "refused", why: "denied" };
  if (!knockProves(nodeCrypto, knock, { host: door.host, ticket: door.ticket(knock.device, knock.epoch) })) return { kind: "refused", why: "denied" };
  if (standing === "expired") return { kind: "refused", why: "expired" };
  return { kind: "admitted", config, device: knock.device };
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function doorHandler(deps: DoorDeps): (request: Request) => Promise<Response> {
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS;
  /** Knocks that arrive while a wake runs in this instance join it. */
  let waking: Promise<DoorOutcome> | null = null;

  const wake = (config: DoorConfig) => {
    if (waking) return waking;
    const started = deps.now();
    const outcome = deps.wake(config).then((done) => {
      deps.log(`door wake ${done.state} in ${deps.now() - started} ms`);
      return done;
    });
    waking = outcome;
    void outcome.finally(() => {
      if (waking === outcome) waking = null;
    });
    return outcome;
  };

  const stream = (outcome: Promise<DoorOutcome>) => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The phone left; the wake runs on.
          }
        };
        write(doorLine({ t: "accepted" }));
        timer = setInterval(() => write("\n"), keepaliveMs);
        void outcome.then((done) => {
          clearInterval(timer);
          write(doorLine({ t: "done", outcome: done }));
          try {
            controller.close();
          } catch {
            // Closed already, by the phone leaving.
          }
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });
  };

  return async (request) => {
    const now = deps.now();
    if (request.method === "GET") return Response.json({ door: 1, mark: deps.config?.mark ?? null }, { headers: { "cache-control": "no-store" } });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const admitted = admit(deps.config, await readBody(request), now);
    if (admitted.kind === "unreadable") return new Response(null, { status: 400 });
    if (admitted.kind === "refused") {
      deps.log(`door refused: ${admitted.why}`);
      return new Response(doorLine({ t: "refused", why: admitted.why, now }), { status: 403, headers: HEADERS });
    }
    deps.log(`door knock from ${admitted.device.slice(0, 8)}`);
    const outcome = wake(admitted.config);
    deps.waitUntil(outcome);
    return new Response(stream(outcome), { headers: HEADERS });
  };
}

function outcomeOf(result: WakeResult): DoorOutcome {
  switch (result.state) {
    case "ready":
      return { state: "ready", route: { kind: "public", host: result.address, port: 443 } };
    case "needs-provision":
      return { state: "needs-mac", why: "setup" };
    case "wrong-key":
      return { state: "needs-mac", why: "key" };
    case "failed":
      return { state: "failed" };
  }
}

/** The Mac's own wake, with the Mac's own inputs: the brain's project by name, never made, then BrainMachine.wake. */
export async function wakeThroughDoor(
  config: DoorConfig,
  log: (line: string) => void,
  find: (access: Parameters<typeof BrainMachine.find>[0]) => Promise<Pick<BrainMachine, "wake"> | null> = (access) => BrainMachine.find(access),
): Promise<DoorOutcome> {
  const secrets = [config.vercel.token, Buffer.from(config.key).toString("base64url")];
  try {
    const machine = await find({ token: config.vercel.token, teamId: config.vercel.teamId, project: config.vercel.project });
    if (!machine) return { state: "needs-mac", why: "setup" };
    const result = await machine.wake({ key: config.key, name: config.name, ...(config.threadVcpus ? { threadVcpus: config.threadVcpus } : {}) });
    if (result.state === "failed" || result.state === "needs-provision") log(`door wake ${result.state}: ${scrub(result.detail, secrets)}`);
    return outcomeOf(result);
  } catch (error) {
    if (vercelDenied(error)) return { state: "needs-mac", why: "vercel" };
    log(`door wake threw: ${scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error), secrets)}`);
    return { state: "failed" };
  }
}

function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((out, secret) => (secret ? out.replaceAll(secret, "[redacted]") : out), text).slice(0, 500);
}

import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { BRAIN_EXIT, encodeControlReply, parseControlRequest, type BrainControlOp, type BrainControlReply, type BrainControlRequest } from "@openorc/cloud";
import { readLine } from "./line.js";

/** One request or reply line; a handover of every kind sealed fits with room to spare. */
const LINE_BYTES = 1024 * 1024;
/** How long a request may take to arrive once its connection opens. */
const ARRIVAL_MS = 5_000;
/** How long `ctl` waits for each kind of answer. A status poll stays short; an import clones a whole project. */
export const ANSWER_MS: Record<BrainControlOp, number> = { status: 5_000, pair: 15_000, handover: 30_000, "import-project": 300_000, stop: 15_000 };

export type ControlAnswer = (request: BrainControlRequest) => Promise<unknown>;

export interface ControlServer {
  /** "control" while a request other than status runs, so the brain does not sleep under it. */
  readonly busy: "control" | null;
  close(): Promise<void>;
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The run socket `ctl` reaches the brain through: one request line in, one reply line out. Status answers at once;
 * every other request waits for the one before it. A failure answers in the handler's words, never the request's.
 */
export async function serveControl(socket: string, answer: ControlAnswer, heard: () => void): Promise<ControlServer> {
  // The run lock means no other brain owns a socket left here; it is a crashed brain's.
  await rm(socket, { force: true });
  let running = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = (request: BrainControlRequest) => {
    running++;
    const result = queue.then(() => answer(request));
    queue = result.catch(() => undefined);
    return result.finally(() => running--);
  };
  const respond = async (connection: Socket) => {
    connection.on("error", () => undefined);
    let reply: BrainControlReply<BrainControlOp>;
    try {
      const request = parseControlRequest(await readLine(connection, { maxBytes: LINE_BYTES, timeoutMs: ARRIVAL_MS }));
      heard();
      reply = { ok: true, result: (await (request.op === "status" ? answer(request) : inTurn(request))) as never };
    } catch (error) {
      reply = { ok: false, error: words(error) };
    }
    connection.end(`${encodeControlReply(reply)}\n`);
  };
  const server = createServer((connection) => void respond(connection));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  await chmod(socket, 0o600);
  return {
    get busy() {
      return running > 0 ? "control" : null;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * `ctl`: one request from `input` to the brain on `socket`, its reply line to `output`. Exits `unavailable` when no
 * brain answers the socket, and gives up with a refusal when the brain takes longer than the request's budget.
 */
export async function askControl(socket: string, input: Readable, output: Writable): Promise<number> {
  const refuse = (error: string) => output.write(`${encodeControlReply({ ok: false, error })}\n`);
  let request: BrainControlRequest;
  try {
    request = parseControlRequest(await readLine(input, { maxBytes: LINE_BYTES, timeoutMs: ARRIVAL_MS }));
  } catch (error) {
    refuse(words(error));
    return BRAIN_EXIT.badStart;
  }
  const connection = createConnection(socket);
  const opened = await new Promise<boolean>((resolve) => {
    connection.once("connect", () => resolve(true));
    connection.once("error", () => resolve(false));
  });
  if (!opened) return BRAIN_EXIT.unavailable;
  connection.on("error", () => undefined);
  connection.write(`${JSON.stringify(request)}\n`);
  try {
    output.write(`${await readLine(connection, { maxBytes: LINE_BYTES, timeoutMs: ANSWER_MS[request.op] })}\n`);
    return 0;
  } catch {
    refuse(`The brain did not answer ${request.op}.`);
    return 1;
  } finally {
    connection.destroy();
  }
}

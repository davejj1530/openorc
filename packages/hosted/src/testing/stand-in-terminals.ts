/**
 * A cloud thread's terminals as the server answers for them, with a shell of its own that echoes what is typed and
 * prompts after each line, so a client can open one, type, watch it over the socket and end it. Only its opener types;
 * anyone who reads the thread watches. While the `terminal` capability is not on, every route answers 409 with its
 * reason, as the server does behind its switch.
 */
import { randomUUID } from "node:crypto";
import { userOf } from "./stand-in-spaces.js";
import type { StandInPeer } from "./stand-in-threads.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
type Person = { name: string; image: string | null };
type Terminal = {
  id: string;
  threadId: string;
  openedBy: string;
  cols: number;
  rows: number;
  state: "open" | "ended";
  output: Buffer;
  typed: number;
  ended: { reason: string; message: string; exitCode: number | null; by: string | null } | null;
};

const OFF = "The terminal isn't available in cloud threads yet.";
const PROMPT = "$ ";
const refused = (status: number, message: string, code?: string): Reply => ({ status, body: { statusCode: status, message, ...(code && { code }) } });
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
/** A watched terminal, beside the threads a socket watches. */
const watchKey = (terminalId: string) => `terminal:${terminalId}`;

export class StandInTerminals {
  readonly #terminals = new Map<string, Terminal>();

  constructor(
    private readonly deps: {
      available(): boolean;
      /** Who reads the thread. */
      readers(threadId: string): string[];
      peers(): Iterable<StandInPeer>;
      person(email: string): Person;
    },
  ) {}

  /** A terminal's shell ends on its own, as an `exit` does, or with the server's reason for another end. */
  end(terminalId: string, ended: { reason: string; message: string; exitCode?: number | null }): void {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal || terminal.state === "ended") return;
    terminal.state = "ended";
    terminal.ended = { reason: ended.reason, message: ended.message, exitCode: ended.exitCode ?? null, by: null };
    this.#changed(terminal);
  }

  /** Output the shell prints by itself, as a command's would be. */
  print(terminalId: string, text: string): void {
    const terminal = this.#terminals.get(terminalId);
    if (terminal) this.#print(terminal, Buffer.from(text, "utf8"));
  }

  /** The terminals of a thread, newest last, for a test to read. */
  of(threadId: string): { id: string; openedBy: string; state: string; typed: string; cols: number; rows: number }[] {
    return [...this.#terminals.values()]
      .filter((terminal) => terminal.threadId === threadId)
      .map((terminal) => ({ id: terminal.id, openedBy: terminal.openedBy, state: terminal.state, typed: terminal.output.toString("utf8"), cols: terminal.cols, rows: terminal.rows }));
  }

  socket(peer: StandInPeer, event: string, body: unknown): unknown {
    const asked = body as { threadId?: unknown; terminalId?: unknown } | null;
    const terminal = typeof asked?.terminalId === "string" ? this.#terminals.get(asked.terminalId) : undefined;
    if (event === "hosted:terminal:unwatch") {
      if (typeof asked?.terminalId === "string") peer.watched.delete(watchKey(asked.terminalId));
      return { ok: true };
    }
    const who = peer.who();
    if (!who || !terminal || terminal.threadId !== asked?.threadId || !this.deps.readers(terminal.threadId).includes(who)) return { ok: false };
    peer.watched.add(watchKey(terminal.id));
    return { ok: true };
  }

  route(request: Request, who: string, body: unknown): Reply | null {
    const [, threadId, terminalId, part] = /^\/hosted\/threads\/([^/]+)\/terminals(?:\/([^/]+)(?:\/(output|input|size))?)?$/.exec(request.path) ?? [];
    if (!threadId) return null;
    if (!this.deps.available()) return refused(409, OFF, "feature_unavailable");
    if (!this.deps.readers(threadId).includes(who)) return refused(404, "That conversation isn't here.");
    if (!terminalId) return request.method === "POST" ? this.#open(threadId, who, body) : this.#list(threadId, who);
    const terminal = this.#terminals.get(terminalId);
    if (!terminal || terminal.threadId !== threadId) return refused(404, "That terminal isn't here.");
    if (request.method === "DELETE") return this.#endBy(terminal, who);
    if (part === "output") return this.#output(terminal, Number(request.query.get("from") ?? 0));
    if (terminal.openedBy !== who) return refused(403, `Only ${first(this.deps.person(terminal.openedBy).name)} can type in this terminal.`);
    if (terminal.state !== "open") return refused(409, "This terminal's shell isn't running.", "terminal_closed");
    if (part === "size") {
      const { cols, rows } = body as { cols: number; rows: number };
      Object.assign(terminal, { cols, rows });
      return { status: 200, body: this.#wire(terminal) };
    }
    return this.#type(terminal, body as { at: number; data: string });
  }

  #list(threadId: string, who: string): Reply {
    const all = [...this.#terminals.values()].filter((terminal) => terminal.threadId === threadId).reverse();
    const other = all.find((terminal) => terminal.state === "open" && terminal.openedBy !== who);
    const reason = other ? `${first(this.deps.person(other.openedBy).name)}'s terminal is open here. End it to open yours.` : null;
    return { status: 200, body: { terminals: all.map((terminal) => this.#wire(terminal)), canOpen: reason === null, reason, viewer: userOf(who) } };
  }

  #open(threadId: string, who: string, body: unknown): Reply {
    const other = [...this.#terminals.values()].find((terminal) => terminal.threadId === threadId && terminal.state === "open" && terminal.openedBy !== who);
    if (other) return refused(409, `${first(this.deps.person(other.openedBy).name)}'s terminal is open here. End it to open yours.`, "terminal_refused");
    const { cols, rows } = body as { cols: number; rows: number };
    const terminal: Terminal = { id: `terminal-${randomUUID()}`, threadId, openedBy: who, cols, rows, state: "open", output: Buffer.from(PROMPT), typed: 0, ended: null };
    this.#terminals.set(terminal.id, terminal);
    return { status: 201, body: this.#wire(terminal) };
  }

  #type(terminal: Terminal, input: { at: number; data: string }): Reply {
    const bytes = Buffer.from(input.data, "utf8");
    const skip = terminal.typed - input.at;
    if (skip >= 0 && skip < bytes.length) {
      const fresh = bytes.subarray(skip);
      terminal.typed = input.at + bytes.length;
      this.#print(terminal, Buffer.from(fresh.toString("utf8").replaceAll("\r", `\r\n${PROMPT}`), "utf8"));
    }
    return { status: 200, body: { at: terminal.typed } };
  }

  #endBy(terminal: Terminal, who: string): Reply {
    if (terminal.state === "open") {
      terminal.state = "ended";
      terminal.ended = { reason: "closed", message: `${first(this.deps.person(who).name)} ended this terminal.`, exitCode: null, by: who };
      this.#changed(terminal);
    }
    return { status: 200, body: this.#wire(terminal) };
  }

  #output(terminal: Terminal, from: number): Reply {
    const start = Math.min(Math.max(0, from), terminal.output.length);
    return { status: 200, body: { from: start, end: terminal.output.length, data: terminal.output.subarray(start).toString("base64"), terminal: this.#wire(terminal) } };
  }

  #print(terminal: Terminal, data: Buffer): void {
    const at = terminal.output.length;
    terminal.output = Buffer.concat([terminal.output, data]);
    this.#send(terminal, "hosted:terminal:output", { terminalId: terminal.id, at, data: data.toString("base64") });
  }

  #changed(terminal: Terminal): void {
    this.#send(terminal, "hosted:terminal:changed", this.#wire(terminal));
  }

  #send(terminal: Terminal, event: string, body: unknown): void {
    const readers = this.deps.readers(terminal.threadId);
    for (const peer of this.deps.peers()) if (peer.watched.has(watchKey(terminal.id)) && readers.includes(peer.who() ?? "")) peer.send(event, body);
  }

  #wire(terminal: Terminal) {
    const person = (email: string) => ({ id: userOf(email), ...this.deps.person(email) });
    return {
      id: terminal.id,
      threadId: terminal.threadId,
      openedBy: person(terminal.openedBy),
      state: terminal.state,
      cols: terminal.cols,
      rows: terminal.rows,
      typed: terminal.typed,
      ended: terminal.ended && { ...terminal.ended, by: terminal.ended.by ? person(terminal.ended.by) : null },
    };
  }
}

/**
 * A cloud thread's terminals, as the window's terminal panel asks for them: each call goes to the thread's space on the
 * server, and a watched terminal's output and changes come back over the socket as `hosted.terminal` pushes. A new
 * socket session joins every watched terminal again and tells the window to read what it may have missed.
 */
import type { HostedTerminal, HostedTerminalPush, RpcParams, RpcResults } from "@openorc/protocol";
import type { Session } from "./session.js";
import type { Threads } from "./threads.js";
import { TERMINAL_ROUTES, TERMINAL_SOCKET, wireTerminal, wireTerminalFrame, wireTerminalWatched } from "./wire-terminals.js";

export class TerminalWatch {
  /** Each watched terminal's thread, by terminal. */
  readonly #watched = new Map<string, string>();

  constructor(private readonly deps: { session: Session; push(push: HostedTerminalPush): void }) {
    deps.session.onSocket(TERMINAL_SOCKET.output, (body) => {
      const frame = wireTerminalFrame.safeParse(body);
      if (frame.success && this.#watched.has(frame.data.terminalId))
        deps.push({ type: "hosted.terminal", terminalId: frame.data.terminalId, event: { kind: "output", at: frame.data.at, data: frame.data.data } });
    });
    deps.session.onSocket(TERMINAL_SOCKET.changed, (body) => {
      const terminal = wireTerminal.safeParse(body);
      if (terminal.success && this.#watched.has(terminal.data.id)) deps.push({ type: "hosted.terminal", terminalId: terminal.data.id, event: { kind: "changed", terminal: terminal.data } });
    });
    deps.session.onChange((change) => {
      if (change !== "connected") return;
      for (const [terminalId, threadId] of this.#watched) {
        void this.#join(threadId, terminalId).then(() => deps.push({ type: "hosted.terminal", terminalId, event: { kind: "gap" } }));
      }
    });
  }

  async watch(threadId: string, terminalId: string, watch: boolean): Promise<null> {
    if (!watch) {
      this.#watched.delete(terminalId);
      await this.deps.session.ask(TERMINAL_SOCKET.unwatch, { threadId, terminalId }, wireTerminalWatched).catch(() => undefined);
      return null;
    }
    this.#watched.set(terminalId, threadId);
    await this.#join(threadId, terminalId);
    return null;
  }

  /** Out of reach, the join is made again on the next socket session. */
  async #join(threadId: string, terminalId: string): Promise<void> {
    await this.deps.session.ask(TERMINAL_SOCKET.watch, { threadId, terminalId }, wireTerminalWatched).catch(() => undefined);
  }
}

const terminal = (wire: HostedTerminal): HostedTerminal => wire;

export const list = (threads: Threads, { threadId }: RpcParams<"hosted.terminal.list">): Promise<RpcResults["hosted.terminal.list"]> => threads.on(threadId).request(TERMINAL_ROUTES.list(threadId));
export const open = async (threads: Threads, { threadId, cols, rows }: RpcParams<"hosted.terminal.open">) =>
  terminal(await threads.on(threadId).request(TERMINAL_ROUTES.open(threadId), { cols, rows }));
export const output = (threads: Threads, { threadId, terminalId, from }: RpcParams<"hosted.terminal.output">): Promise<RpcResults["hosted.terminal.output"]> =>
  threads.on(threadId).request(TERMINAL_ROUTES.output(threadId, terminalId, from));
export const input = (threads: Threads, { threadId, terminalId, at, data }: RpcParams<"hosted.terminal.input">) =>
  threads.on(threadId).request(TERMINAL_ROUTES.input(threadId, terminalId), { at, data });
export const size = async (threads: Threads, { threadId, terminalId, cols, rows }: RpcParams<"hosted.terminal.size">) =>
  terminal(await threads.on(threadId).request(TERMINAL_ROUTES.size(threadId, terminalId), { cols, rows }));
export const end = async (threads: Threads, { threadId, terminalId }: RpcParams<"hosted.terminal.end">) => terminal(await threads.on(threadId).request(TERMINAL_ROUTES.end(threadId, terminalId)));
export const watch = (threads: Threads, { threadId, terminalId, watch }: RpcParams<"hosted.terminal.watch">) => {
  threads.on(threadId);
  return threads.terminals.watch(threadId, terminalId, watch);
};

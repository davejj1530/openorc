import { z } from "zod";

/**
 * A cloud thread's terminal: a login shell on the thread's machine holding the sign-in of the person who opened it, so
 * only they type in it; everyone who reads the thread watches it. Output is counted in bytes from the shell's first, so
 * a reader asks from an offset and is told where what it got really starts.
 */
const person = z.object({ id: z.string(), name: z.string(), image: z.string().nullable() });
export const HostedTerminal = z.object({
  id: z.string(),
  threadId: z.string(),
  openedBy: person,
  state: z.enum(["opening", "open", "ended"]),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Bytes of keystrokes it has taken: where its opener's next keystrokes start. */
  typed: z.number().int().nonnegative(),
  /** How it ended, in the server's words for that end alone. */
  ended: z.object({ reason: z.string(), message: z.string(), exitCode: z.number().int().nullable(), by: person.nullable() }).nullable(),
});
export type HostedTerminal = z.infer<typeof HostedTerminal>;

/** A thread's terminals, newest first, whether the reader may open one (and why not), and who the reader is. */
export type HostedTerminals = { terminals: HostedTerminal[]; canOpen: boolean; reason: string | null; viewer: string };
/** Output from `from` (base64), later than asked when the rest is no longer kept, to `end`. */
export type HostedTerminalOutput = { from: number; end: number; data: string; terminal: HostedTerminal };

const thread = { threadId: z.string() };
const terminal = { threadId: z.string(), terminalId: z.string().min(1).max(200) };
const size = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) };

/** Requested by desktop windows only, routed to the thread's place. A paired phone has no cloud terminal. */
export const hostedTerminalRpcParams = {
  "hosted.terminal.list": z.object(thread).strict(),
  "hosted.terminal.open": z.object({ ...thread, ...size }).strict(),
  "hosted.terminal.output": z.object({ ...terminal, from: z.number().int().nonnegative() }).strict(),
  /** Keystrokes from the opener's offset `at`: what the terminal took before is typed no second time. */
  "hosted.terminal.input": z
    .object({
      ...terminal,
      at: z.number().int().nonnegative(),
      data: z
        .string()
        .min(1)
        .max(64 * 1024),
    })
    .strict(),
  "hosted.terminal.size": z.object({ ...terminal, ...size }).strict(),
  "hosted.terminal.end": z.object(terminal).strict(),
  /** Follows a terminal's output and changes as `hosted.terminal` pushes, or stops following it. */
  "hosted.terminal.watch": z.object({ ...terminal, watch: z.boolean() }).strict(),
};
export interface HostedTerminalRpcResults {
  "hosted.terminal.list": HostedTerminals;
  "hosted.terminal.open": HostedTerminal;
  "hosted.terminal.output": HostedTerminalOutput;
  "hosted.terminal.input": { at: number };
  "hosted.terminal.size": HostedTerminal;
  "hosted.terminal.end": HostedTerminal;
  "hosted.terminal.watch": null;
}

/**
 * Core to the Mac's windows, never to a phone: a watched terminal printed `data` (base64) from `at`, changed, or
 * may have missed output while out of reach (`gap`: read again from where the window is).
 */
export const HostedTerminalPush = z.object({
  type: z.literal("hosted.terminal"),
  terminalId: z.string(),
  event: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("output"), at: z.number().int().nonnegative(), data: z.string() }),
    z.object({ kind: z.literal("changed"), terminal: HostedTerminal }),
    z.object({ kind: z.literal("gap") }),
  ]),
});
export type HostedTerminalPush = z.infer<typeof HostedTerminalPush>;

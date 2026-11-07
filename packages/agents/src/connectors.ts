import { spawn } from "node:child_process";
import type { ConnectorSource, ConnectorSpec, ConnectorStatus } from "@openorc/protocol";
import { launchCommand } from "./command-launch.js";
import type { AgentLaunchEnvironment } from "./launch-environment.js";
import { stopProcess } from "./process-lifetime.js";

/** One MCP server as one agent, in one place, reports it. */
export interface ConnectorRow {
  name: string;
  title: string;
  source: ConnectorSource;
  kind: "command" | "url" | null;
  status: ConnectorStatus;
  error?: string;
  /** Images the server offers, most preferred first. */
  icons: string[];
}

/**
 * What OpenOrc asks of one agent about its MCP servers. The agent stays their owner: writes go through its own command
 * or its own configuration file, so what the terminal sees and what OpenOrc sees never differ.
 */
export interface ConnectorDriver {
  read(folder: string): Promise<ConnectorRow[]>;
  /** The connector as saved, secrets included, for editing. Null when it is not the user's to edit. */
  spec(name: string): Promise<ConnectorSpec | null>;
  save(name: string, spec: ConnectorSpec): Promise<void>;
  remove(name: string): Promise<void>;
  /** Absent where the agent has no such setting, so OpenOrc tells each of its runs instead. */
  setOn?: (name: string, on: boolean) => Promise<void>;
  /** Resolves once the sign-in lasts, having handed `open` the address to show the user. */
  signIn(name: string, folder: string, open: (url: string) => void, signal: AbortSignal): Promise<void>;
  signOut(name: string, folder: string): Promise<void>;
}

export const CONNECTOR_READ_WAIT_MS = 8_000;
export const CONNECTOR_SIGN_IN_MS = 5 * 60_000;

/**
 * An agent's error, fit to show: its text can run to pages and repeat the server's address, whose path may hold a token.
 * The address stays as its host.
 */
export function readableConnectorError(text: string): string {
  const hosts = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (address) => {
    try {
      return new URL(address).host || "the server";
    } catch {
      return "the server";
    }
  });
  const first = hosts.split(/\r?\n/)[0]!.trim();
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

/** The address of every image in an MCP `icons` list. */
export function iconSources(icons: unknown): string[] {
  if (!Array.isArray(icons)) return [];
  return icons.flatMap((icon: unknown) => {
    const src = icon && typeof icon === "object" ? (icon as { src?: unknown }).src : null;
    return typeof src === "string" && src ? [src] : [];
  });
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects when `signal` fires, for racing a wait against the user's Cancel. */
export function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const stop = () => reject(new Error("Sign-in cancelled"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Runs one of the agent's own commands to its end, rejecting with what it printed if it fails. */
export function runAgentCommand(launch: Pick<AgentLaunchEnvironment, "binary" | "env">, args: string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...launch.env };
    delete env["CLAUDECODE"];
    const command = launchCommand(launch.binary, args);
    const proc = spawn(command.file, command.args, { ...command.options, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => stopProcess(proc), timeoutMs);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(readableConnectorError(output.trim()) || "The agent could not save this connector."));
    });
  });
}

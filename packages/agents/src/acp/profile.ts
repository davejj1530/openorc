import type { McpServer, PromptResponse } from "@agentclientprotocol/sdk";
import type { PermissionPreset, RunMode, RunSpec, RunStatus } from "@openorc/protocol";
import type { AgentHost, LaunchPlace } from "../agent-host.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

/** The harnesses OpenOrc drives over the Agent Client Protocol. */
export type AcpAgent = "opencode" | "omp" | "cursor" | "antigravity" | "fx";

/** What a run's ACP server needs to know about OpenOrc's side of it. */
export interface AcpRunContext {
  host: AgentHost | undefined;
  /** Where the run's own files go before the agent starts: this Mac's disk, or the host's. */
  place: LaunchPlace;
  /** OpenOrc's MCP server as the agent reaches it, when the run has one. */
  mcpUrl: string | undefined;
  serverName: string;
  /** OpenOrc answers the agent's questions through its ask_user tool. */
  askUser: boolean;
}

/** Runs the agent's command line once where a run's session is, here or on its host, and resolves with what it printed. */
export type AgentCommand = (args: string[]) => Promise<string>;

/** The ACP server's command line and environment for one run. */
export interface AcpLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Where the process starts, when not in the run's folder; the session still works there. */
  cwd?: string;
  /** A folder the run made for its own files, removed when the process ends. */
  privateDir?: string;
}

/**
 * What differs between the agents OpenOrc drives over ACP. The protocol is the same; each agent names its settings
 * differently, keeps Plan its own way and loads its own project files, which an unvetted checkout must not run.
 */
export interface AcpProfile {
  readonly agent: AcpAgent;
  /** The product name, for messages. */
  readonly name: string;
  /** The session option that carries reasoning effort. */
  readonly effortOption: string | null;
  /** A separate provider selector; model IDs include that connection before the first slash. */
  readonly providerOption?: string;
  /** A single account bills every model, regardless of the model's maker. */
  readonly modelAccount?: { id: string; label: string };
  /** Reuses a CLI login through ACP before opening sessions. */
  readonly authMethod?: string | ((env: NodeJS.ProcessEnv) => string | undefined);
  /** Cursor restores sessions through the stable load method and does not offer forks. */
  readonly loadSession?: boolean;
  /** The agent accepts another session/prompt during a turn, rather than the steering extension. */
  readonly promptSteering?: boolean;
  readonly steeringMeta?: Record<string, unknown>;
  readonly textOnlySteering?: boolean;
  steeringOutcome?(response: PromptResponse): "accepted" | "unavailable";
  /** Native terminal names or provider errors not represented by the standard ACP response. */
  promptOutcome?(reason: string, text: string): { status: RunStatus; error?: Error } | undefined;
  /** The native compaction command, or null when ACP cannot compact on request. */
  readonly compactCommand?: string | null;
  /** Fails before ACP can open an interactive sign-in flow. */
  checkReady?(launch: AgentLaunchEnvironment, cwd?: string): Promise<void>;
  /** Capabilities beyond the protocol's that OpenOrc tells the agent it handles. */
  readonly clientMeta?: Record<string, unknown>;
  /** Per-session integration options, including a native opt-in to the user's saved MCP servers. */
  sessionMeta?(spec: RunSpec): Record<string, unknown>;
  /** Launch sets the permission mode without changing the user's terminal defaults. Verify it instead of writing it. */
  readonly modeInLaunch?: boolean;
  /**
   * The agent asks its own questions, approvals and plan sign-off through form elicitations, which OpenOrc answers with
   * its cards. Without them it uses OpenOrc's ask_user tool and Plan rules.
   */
  readonly elicitation: boolean;
  /**
   * OpenOrc's MCP server goes in the configuration `launch` writes rather than in `session/new`, where the agent could
   * not be told to list its tools directly. The session then gets the user's servers alone.
   */
  readonly ownServerInLaunch?: boolean;
  /**
   * The ACP server's arguments and environment for a run. Throws, before anything starts, when the run cannot be held to
   * what OpenOrc promises, as for an unvetted checkout whose own settings could run code.
   */
  launch(spec: RunSpec, base: NodeJS.ProcessEnv, context: AcpRunContext): AcpLaunch;
  /** The `mode` option's value for a run mode. */
  modeValue(mode: RunMode, permission: PermissionPreset): string;
  /** What the agent reads ahead of the first message about OpenOrc's tools for this run, if anything. */
  briefing(spec: RunSpec, context: AcpRunContext): string | undefined;
  /**
   * MCP servers of the user's own the agent takes from OpenOrc rather than its own configuration, read as the run starts.
   * Only on this Mac: a host's runs get OpenOrc's tools alone.
   */
  userServers?(env: NodeJS.ProcessEnv): Promise<McpServer[]>;
  /** The whole plan a session proposed, read from where the agent keeps it on this Mac; null when it cannot be read here. */
  planText?(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | null>;
  /**
   * For an agent whose reported cost counts the session alone, a reader of what its subagents have cost so far, added
   * to that cost after each turn. One reader per run, so it can keep what it read before.
   */
  subagentCosts?(run: AgentCommand): (sessionId: string) => Promise<number>;
  /**
   * For an agent whose ACP server can't take a message into a running turn, how OpenOrc delivers one there itself, with
   * its pictures as paths where the agent runs. Without it, the agent says in `initialize` whether it steers.
   */
  steer?(run: AgentCommand, sessionId: string, text: string, images: string[]): Promise<"accepted" | "unavailable">;
}

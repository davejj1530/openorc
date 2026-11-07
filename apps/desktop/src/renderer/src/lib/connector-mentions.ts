import { useCallback, useMemo, useState } from "react";
import { threadHasConnectors, usableConnectors, type AgentKind, type ExecutionMode, type FileScope, type UsableConnector } from "@openorc/protocol";
import type { SkillCommands } from "@openorc/client";
import { useClaudeAccountId } from "./claude-account";
import { useRpc } from "./client";
import { useSkillCommands } from "./skill-commands";

const NO_SCOPE: FileScope = { kind: "project", id: "" };
const NONE: UsableConnector[] = [];

export interface ConnectorMentions {
  /** The connectors the agent has now, which `@` can name. */
  connectors: UsableConnector[];
  /** Connected ones it does not have in this mode, which `@` lists dimmed with why. */
  connectorsAside?: { connectors: UsableConnector[]; reason: string } | undefined;
  /** The list is being read for the first time. */
  connectorsLoading?: boolean;
  /** An `@` word started: read the list if it is not read yet. Reading starts the agents' servers, so not before. */
  onConnectorsWanted: () => void;
}

/** Why an agent goes without the user's connectors in a mode, as its launch decides. */
const asideReason = (mode: ExecutionMode) => (mode === "plan" ? "Connectors are off while planning." : "Claude has connectors in Autonomous mode.");

/**
 * The connectors a composer's `@` offers: connected for its agent, and on the account it runs on. In a mode where the
 * agent goes without them they are still listed, dimmed with why, so `@` always shows what there is.
 */
export function useConnectorMentions(scope: FileScope | null, agent: AgentKind | null | undefined, mode: ExecutionMode, selectedAccountId?: string): ConnectorMentions {
  const scopedAccountId = useClaudeAccountId();
  const accountId = selectedAccountId ?? scopedAccountId;
  const harness = agent === "acp" ? "opencode" : agent;
  const listed = Boolean(scope && harness);
  const offered = Boolean(listed && harness && threadHasConnectors(harness, mode));
  const [wanted, setWanted] = useState(false);
  const list = useRpc("connectors.list", { scope: scope ?? NO_SCOPE }, { enabled: listed && wanted, staleTime: 60_000 });
  const all = useMemo(() => (listed && harness ? usableConnectors(list.data, harness, accountId) : NONE), [listed, harness, list.data, accountId]);
  const onConnectorsWanted = useCallback(() => setWanted(true), []);
  // Stable while nothing changes, so the transcript's messages don't redraw with every streamed line.
  const connectorsAside = useMemo(() => (!offered && all.length ? { connectors: all, reason: asideReason(mode) } : undefined), [offered, all, mode]);
  return {
    connectors: offered ? all : NONE,
    connectorsAside,
    connectorsLoading: listed && wanted && list.isPending,
    onConnectorsWanted,
  };
}

/** Everything a composer offers as the user types: the agent's skills and the connectors `@` can name. */
export function useComposerSuggestions(scope: FileScope | null, agent: AgentKind | null | undefined, mode: ExecutionMode, selectedAccountId?: string): SkillCommands & ConnectorMentions {
  return { ...useSkillCommands(scope, agent, selectedAccountId), ...useConnectorMentions(scope, agent, mode, selectedAccountId) };
}

/** A run of the message, and the connector it names when it is an `@name` the agent has. */
export interface ConnectorSpan {
  text: string;
  connector?: UsableConnector;
}

/** Splits text at every `@name` that starts a word and names a connector, longest name first. */
export function connectorSpans(text: string, connectors: readonly UsableConnector[]): ConnectorSpan[] {
  if (!connectors.length || !text.includes("@")) return text ? [{ text }] : [];
  const byName = new Map(connectors.map((connector) => [connector.name.toLowerCase(), connector]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
  const pattern = new RegExp(`(^|\\s)(@(${names.join("|")}))(?![\\w-])`, "gi");
  const spans: ConnectorSpan[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + (match[1] ?? "").length;
    if (start > at) spans.push({ text: text.slice(at, start) });
    spans.push({ text: match[2]!, connector: byName.get(match[3]!.toLowerCase())! });
    at = start + match[2]!.length;
  }
  if (at < text.length) spans.push({ text: text.slice(at) });
  return spans;
}

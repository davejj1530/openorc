import { useCallback, useMemo, useState } from "react";
import { threadHasConnectors, usableConnectors, type AgentKind, type ExecutionMode, type FileScope, type UsableConnector } from "@openorc/protocol";
import type { SkillCommands } from "@openorc/client";
import { useClaudeAccountId } from "./claude-account";
import { useRpc } from "./client";
import { useSkillCommands } from "./skill-commands";

const NO_SCOPE: FileScope = { kind: "project", id: "" };

export interface ConnectorMentions {
  connectors: UsableConnector[];
  /** An `@` word started: read the list if it is not read yet. Reading starts the agents' servers, so not before. */
  onConnectorsWanted: () => void;
}

/** The connectors a composer can name with `@`: connected for its agent, in a mode where the agent has them. */
export function useConnectorMentions(scope: FileScope | null, agent: AgentKind | null | undefined, mode: ExecutionMode, selectedAccountId?: string): ConnectorMentions {
  const scopedAccountId = useClaudeAccountId();
  const accountId = selectedAccountId ?? scopedAccountId;
  const harness = agent === "acp" ? "opencode" : agent;
  const offered = Boolean(scope && harness && threadHasConnectors(harness, mode));
  const [wanted, setWanted] = useState(false);
  const list = useRpc("connectors.list", { scope: scope ?? NO_SCOPE }, { enabled: offered && wanted, staleTime: 60_000 });
  const connectors = useMemo(() => (offered && harness ? usableConnectors(list.data, harness, accountId) : []), [offered, harness, list.data, accountId]);
  const onConnectorsWanted = useCallback(() => setWanted(true), []);
  return { connectors, onConnectorsWanted };
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

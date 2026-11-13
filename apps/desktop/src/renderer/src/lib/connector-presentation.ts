import { harnessCatalog, type AgentConnector, type Connector, type ConnectorSource, type ConnectorStatus } from "@openorc/protocol";

/** The worse state wins, so a row reads what most needs doing. */
const RANK: ConnectorStatus[] = ["needs-sign-in", "failed", "configured", "connected", "off"];

export const statusLabel: Record<ConnectorStatus, string> = {
  connected: "Connected",
  configured: "Configured",
  "needs-sign-in": "Needs sign-in",
  failed: "Can’t connect",
  off: "Off",
};

export function connectorStatus(connector: Connector): ConnectorStatus {
  const all = connector.agents.flatMap((agent) => agent.places.map((place) => place.status));
  return RANK.find((status) => all.includes(status)) ?? "off";
}

const listed = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** How one agent stands: a word where it runs in one place, and by account where Claude runs in several. */
export function agentStatusText(agent: AgentConnector): string {
  if (agent.places.length < 2) {
    const place = agent.places[0];
    return place ? statusLabel[place.status] : "";
  }
  const groups = RANK.flatMap((status) => {
    const names = agent.places.filter((place) => place.status === status).map((place) => place.accountName ?? "");
    return names.length ? [{ status, names }] : [];
  });
  if (groups.length === 1) return statusLabel[groups[0]!.status];
  return groups.map(({ status, names }) => `${statusLabel[status]} on ${listed(names)}`).join(". ");
}

export const agentName = (agent: AgentConnector) => harnessCatalog[agent.agent].name;

const kindWords: Record<NonNullable<Connector["kind"]>, string> = { url: "Remote server", command: "Runs on this computer" };
const sourceWords: Partial<Record<ConnectorSource, string>> = { project: "From a project", plugin: "From a plugin", account: "From your Claude account" };

/** Where a connector comes from and how it runs, in one short line: "Remote server · From a plugin". */
export function connectorOrigin(connector: Connector): string {
  const source = connector.agents.map((agent) => sourceWords[agent.source]).find(Boolean);
  return [connector.kind ? kindWords[connector.kind] : null, source].filter(Boolean).join(" · ");
}

/** Connectors from the user's Claude account that it has never connected: listed, but out of the way. */
export function isDormant(connector: Connector): boolean {
  return connector.agents.every((agent) => agent.source === "account" && agent.places.every((place) => place.status === "needs-sign-in"));
}

export const isYours = (connector: Connector) => connector.agents.some((agent) => agent.editable);

/** Words of a command line, honouring quotes, so a path with a space stays one argument. */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

export function joinCommandLine(words: string[]): string {
  return words.map((word) => (word === "" || /[\s"']/.test(word) ? `"${word.replace(/"/g, "'")}"` : word)).join(" ");
}

/** The first letter that stands in for a connector without an image. */
export const logoLetter = (title: string) => (title.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

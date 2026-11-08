import { spawn } from "node:child_process";
import os from "node:os";
import { claudeConnectorDriver, codexConnectorDriver, openCodeConnectorDriver, readableConnectorError, type AgentLaunchEnvironment, type ConnectorDriver, type ConnectorRow } from "@openorc/agents";
import { harnessIds, type AgentConnector, type Connector, type ConnectorList, type ConnectorSignIn, type ConnectorSpec, type HarnessId } from "@openorc/protocol";
import { iconImage, LOGO_BYTES, logoSource, SiteLogos } from "./connector-logos.js";
import { nothingRemembered, type RememberedConnectors } from "./remembered-connectors.js";
import type { AppSettingsService } from "./settings.js";

type Launch = Pick<AgentLaunchEnvironment, "binary" | "env">;

/** One place an agent answers about its connectors: Codex, OpenCode, or one Claude account. */
interface Place {
  agent: HarnessId;
  accountId?: string;
  accountName?: string;
  driver: ConnectorDriver;
}

/** Where each agent answers. A missing agent throws, with the reason the user sees. */
export interface ConnectorPlaces {
  claudeAccounts(): { id: string; name: string; launch: Launch }[];
  /** The CLI login, which owns the servers every account shares. */
  claudeLogin(): Launch;
  codex(): Launch;
  opencode(): Launch;
}

export interface ConnectorDrivers {
  claude(launch: Launch, off: () => string[]): ConnectorDriver;
  codex(launch: Launch): ConnectorDriver;
  opencode(launch: Launch): ConnectorDriver;
}

const realDrivers: ConnectorDrivers = { claude: claudeConnectorDriver, codex: codexConnectorDriver, opencode: openCodeConnectorDriver };
const AGENTS: readonly HarnessId[] = harnessIds;
const FRESH_MS = 60_000;

interface Reading {
  at: number;
  rows: { place: Place; rows: ConnectorRow[] }[];
  unavailable: ConnectorList["unavailable"];
}

interface SignInRun {
  current: ConnectorSignIn;
  abort: AbortController;
}

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i;

/** What hands an address to the default browser, before the address itself. */
const BROWSER_OPENERS: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ["open"], win32: ["rundll32", "url.dll,FileProtocolHandler"] };

/** Hands an address to the browser the user signs in with. */
export function openInBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const [file, ...args] = BROWSER_OPENERS[process.platform] ?? ["xdg-open"];
  spawn(file!, [...args, url], { detached: true, stdio: "ignore" })
    .on("error", () => undefined)
    .unref();
}

/** The hosts each connector's servers live at, by connector name. */
function connectorSites(readings: Reading["rows"]): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const { rows } of readings) for (const row of rows) if (row.site) sites.set(row.name, [...(sites.get(row.name) ?? []), row.site]);
  return sites;
}

/** Groups what every place said by connector name, so one row stands for the same server everywhere. */
export function mergeConnectors(readings: Reading["rows"], logos: ReadonlyMap<string, string>): Connector[] {
  const byName = new Map<string, Connector>();
  for (const { place, rows } of readings) {
    for (const row of rows) {
      const connector = byName.get(row.name) ?? { name: row.name, title: row.title, kind: row.kind, logo: null, agents: [] };
      connector.kind ??= row.kind;
      connector.logo ??= row.icons.map((src) => logos.get(src)).find(Boolean) ?? null;
      let agent = connector.agents.find((entry) => entry.agent === place.agent);
      if (!agent) {
        const editable = row.source === "user";
        agent = { agent: place.agent, source: row.source, editable, switchable: place.agent === "claude" || editable, places: [] } satisfies AgentConnector;
        connector.agents.push(agent);
      }
      agent.places.push({
        ...(place.accountId ? { accountId: place.accountId, accountName: place.accountName } : {}),
        status: row.status,
        ...(row.error ? { error: row.error } : {}),
      });
      byName.set(row.name, connector);
    }
  }
  return [...byName.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

/**
 * Every agent's MCP servers as one list, and the changes the user makes to them. Each agent stays their owner: this
 * asks the agents and writes through them, and keeps only Claude's off switches, which Claude has no setting for.
 */
export class ConnectorService {
  private readonly readings = new Map<string, { value: Reading | null; pending: Promise<Reading> | null; generation: number }>();
  /** Counts changes, so a read that started before one is never taken for what is there now. */
  private generation = 0;
  private readonly logos = new Map<string, string>();
  /** The last image each connector showed, kept while it is signed out or off and so sends none. */
  private readonly logoByName = new Map<string, string>();
  private readonly fetchingLogos = new Map<string, Promise<void>>();
  private signIn: SignInRun | null = null;
  private signInError: string | null = null;

  private readonly open: (url: string) => void;
  private readonly drivers: ConnectorDrivers;
  /** Images from the makers' sites, for servers that send none. */
  private readonly siteLogos: Pick<SiteLogos, "get" | "look">;
  private readonly remembered: RememberedConnectors;

  constructor(
    private readonly places: ConnectorPlaces,
    private readonly settings: AppSettingsService,
    private readonly changed: () => void,
    options: { open?: (url: string) => void; drivers?: ConnectorDrivers; siteLogos?: Pick<SiteLogos, "get" | "look">; remembered?: RememberedConnectors } = {},
  ) {
    this.open = options.open ?? openInBrowser;
    this.drivers = options.drivers ?? realDrivers;
    this.siteLogos = options.siteLogos ?? new SiteLogos();
    this.remembered = options.remembered ?? nothingRemembered;
  }

  get hasPendingWork(): boolean {
    return this.signIn !== null;
  }

  /**
   * The connectors in `folder`. Reading them starts every agent's servers, which takes a while, so a list read since
   * the start answers at once and reads again behind it once stale. Before the first read since the start, the list
   * last read here answers while that read runs.
   */
  async list(folder = os.homedir(), refresh = false): Promise<ConnectorList> {
    const entry = this.readings.get(folder);
    const fresh = entry?.value && Date.now() - entry.value.at < FRESH_MS;
    const remembered = refresh || entry?.value ? null : this.remembered.load(folder);
    if (remembered) {
      void this.read(folder).then(this.changed, () => undefined);
      return { ...this.answer(folder), connectors: remembered, checking: true };
    }
    if (refresh || !entry?.value) await this.read(folder);
    else if (!fresh) void this.read(folder).then(this.changed, () => undefined);
    return this.answer(folder);
  }

  async spec(agent: HarnessId, name: string): Promise<ConnectorSpec | null> {
    return this.driver(agent).spec(name);
  }

  /**
   * Adds a connector, or saves an edit to the one named `previousName`: to the agents named, and away from the other
   * agents where the user had saved it. A name already in use is refused rather than written over.
   */
  async save(input: { name: string; previousName?: string; spec: ConnectorSpec; agents: HarnessId[] }): Promise<{ failed: ConnectorList["unavailable"] }> {
    const from = input.previousName ?? input.name;
    if (from !== input.name || input.previousName === undefined) {
      if (this.knownNames().has(input.name)) throw new Error(`A connector named ${input.name} already exists.`);
    }
    const editable = input.previousName === undefined ? new Set<HarnessId>() : this.editableAgents(from);
    const failed = await this.eachAgent(
      AGENTS.filter((agent) => input.agents.includes(agent) || editable.has(agent)),
      async (agent) => {
        const driver = this.driver(agent);
        if (input.agents.includes(agent)) await driver.save(input.name, input.spec);
        if (editable.has(agent) && (from !== input.name || !input.agents.includes(agent))) await driver.remove(from);
      },
    );
    if (from !== input.name) this.settings.set({ claudeConnectorsOff: this.settings.get().claudeConnectorsOff.map((entry) => (entry === from ? input.name : entry)) });
    this.forget();
    return { failed };
  }

  async remove(name: string): Promise<{ failed: ConnectorList["unavailable"] }> {
    const agents = this.editableAgents(name);
    const failed = await this.eachAgent([...agents], (agent) => this.driver(agent).remove(name));
    this.settings.set({ claudeConnectorsOff: this.settings.get().claudeConnectorsOff.filter((entry) => entry !== name) });
    // Gone now, not after the next read: a row left standing could be removed twice.
    const removed = new Set([...agents].filter((agent) => !failed.some((entry) => entry.agent === agent)));
    for (const entry of this.readings.values()) {
      if (!entry.value) continue;
      entry.value.rows = entry.value.rows.map(({ place, rows }) => ({ place, rows: removed.has(place.agent) ? rows.filter((row) => row.name !== name || row.source !== "user") : rows }));
    }
    this.forget();
    return { failed };
  }

  async setOn(agent: HarnessId, name: string, on: boolean): Promise<void> {
    const driver = this.driver(agent);
    if (driver.setOn) await driver.setOn(name, on);
    else {
      const others = this.settings.get().claudeConnectorsOff.filter((entry) => entry !== name);
      this.settings.set({ claudeConnectorsOff: on ? others : [...others, name] });
    }
    this.forget();
  }

  /** Signs in everywhere it is still needed, one place at a time, so each browser page is the only one open. */
  signInEverywhere(name: string, folder = os.homedir()): { started: boolean } {
    if (this.signIn) return { started: false };
    const reading = this.readings.get(folder)?.value;
    const queue = (reading?.rows ?? []).filter(({ rows }) => rows.some((row) => row.name === name && row.status === "needs-sign-in")).map(({ place }) => place);
    if (!queue.length) return { started: false };
    const abort = new AbortController();
    this.signInError = null;
    const run = async () => {
      for (const [index, place] of queue.entries()) {
        if (abort.signal.aborted) return;
        this.signIn = {
          abort,
          current: { name, agent: place.agent, ...(place.accountName ? { accountName: place.accountName } : {}), remaining: queue.length - index - 1 },
        };
        this.changed();
        await place.driver.signIn(name, folder, this.open, abort.signal);
      }
    };
    void run()
      .catch((error: unknown) => {
        if (!abort.signal.aborted) this.signInError = readableConnectorError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.signIn = null;
        this.forget();
      });
    return { started: true };
  }

  cancelSignIn(): void {
    this.signIn?.abort.abort();
  }

  async signOut(name: string, folder = os.homedir()): Promise<{ failed: ConnectorList["unavailable"] }> {
    const reading = this.readings.get(folder)?.value ?? (await this.read(folder));
    const places = reading.rows.filter(({ rows }) => rows.some((row) => row.name === name && row.kind === "url" && row.status === "connected")).map(({ place }) => place);
    const failed: ConnectorList["unavailable"] = [];
    for (const place of places) {
      await place.driver.signOut(name, folder).catch((error: unknown) => failed.push({ agent: place.agent, reason: readableConnectorError(String(error instanceof Error ? error.message : error)) }));
    }
    this.forget();
    return { failed };
  }

  private answer(folder: string): ConnectorList {
    const reading = this.readings.get(folder);
    const sites = connectorSites(reading?.value?.rows ?? []);
    const connectors = mergeConnectors(reading?.value?.rows ?? [], this.logos).map((connector) => {
      const logo = connector.logo ?? this.siteLogos.get(logoSource(connector.title, sites.get(connector.name) ?? []));
      if (logo) this.logoByName.set(connector.name, logo);
      return { ...connector, logo: logo ?? this.logoByName.get(connector.name) ?? null };
    });
    return {
      connectors,
      unavailable: reading?.value?.unavailable ?? [],
      checking: Boolean(reading?.pending),
      signIn: this.signIn?.current ?? null,
      signInError: this.signInError,
    };
  }

  private read(folder: string): Promise<Reading> {
    const entry = this.readings.get(folder) ?? { value: null, pending: null, generation: -1 };
    this.readings.set(folder, entry);
    if (entry.pending && entry.generation === this.generation) return entry.pending;
    const previous = entry.pending;
    const generation = this.generation;
    const pending: Promise<Reading> = (async () => {
      await previous?.catch(() => undefined);
      const value = await this.readEverywhere(folder);
      // A change landed while this read ran: keep the answer to show, but read again before trusting it.
      entry.value = generation === this.generation ? value : { ...value, at: 0 };
      this.remembered.save(folder, this.answer(folder).connectors);
      return value;
    })().finally(() => {
      if (entry.pending === pending) entry.pending = null;
    });
    entry.pending = pending;
    entry.generation = generation;
    return pending;
  }

  private async readEverywhere(folder: string): Promise<Reading> {
    const unavailable: Reading["unavailable"] = [];
    const places: Place[] = [];
    for (const agent of AGENTS) {
      try {
        places.push(...this.placesOf(agent));
      } catch (error) {
        unavailable.push({ agent, reason: readableConnectorError(error instanceof Error ? error.message : String(error)) });
      }
    }
    // Two at a time: every read starts the servers it reports on.
    const rows: Reading["rows"] = [];
    const queue = [...places];
    await Promise.all(
      [0, 1].map(async () => {
        for (let place = queue.shift(); place; place = queue.shift()) {
          const current = place;
          await current.driver
            .read(folder)
            .then((found) => rows.push({ place: current, rows: found }))
            .catch((error: unknown) => {
              if (!unavailable.some((entry) => entry.agent === current.agent))
                unavailable.push({ agent: current.agent, reason: readableConnectorError(error instanceof Error ? error.message : String(error)) });
            });
        }
      }),
    );
    this.retireLegacySwitch(rows);
    await this.fetchLogos(rows.flatMap((entry) => entry.rows.flatMap((row) => row.icons.slice(0, 1))));
    this.lookForSiteLogos(rows);
    rows.sort((a, b) => places.indexOf(a.place) - places.indexOf(b.place));
    return { at: Date.now(), rows, unavailable };
  }

  /** Before switches, one setting turned all of Claude's servers off; it becomes a switch per server, once. */
  private retireLegacySwitch(rows: Reading["rows"]): void {
    if (this.settings.get().claudeUserMcpServers !== false) return;
    const claude = rows.find((entry) => entry.place.agent === "claude");
    if (!claude) return;
    const names = new Set([...this.settings.get().claudeConnectorsOff, ...claude.rows.map((row) => row.name)]);
    this.settings.set({ claudeUserMcpServers: true, claudeConnectorsOff: [...names] });
  }

  private placesOf(agent: HarnessId): Place[] {
    if (agent === "claude") return this.places.claudeAccounts().map(({ id, name, launch }) => ({ agent, accountId: id, accountName: name, driver: this.claudeDriver(launch) }));
    return [{ agent, driver: this.driver(agent) }];
  }

  private claudeDriver(launch: Launch): ConnectorDriver {
    return this.drivers.claude(launch, () => this.settings.get().claudeConnectorsOff);
  }

  /** The driver that writes for `agent`; for Claude, the CLI login's, whose servers every account shares. */
  private driver(agent: HarnessId): ConnectorDriver {
    if (agent === "claude") return this.claudeDriver(this.places.claudeLogin());
    return agent === "codex" ? this.drivers.codex(this.places.codex()) : this.drivers.opencode(this.places.opencode());
  }

  private knownNames(): Set<string> {
    return new Set([...this.readings.values()].flatMap((entry) => (entry.value?.rows ?? []).flatMap(({ rows }) => rows.map((row) => row.name))));
  }

  private editableAgents(name: string): Set<HarnessId> {
    const agents = new Set<HarnessId>();
    for (const entry of this.readings.values()) {
      for (const { place, rows } of entry.value?.rows ?? []) if (rows.some((row) => row.name === name && row.source === "user")) agents.add(place.agent);
    }
    return agents;
  }

  private async eachAgent(agents: readonly HarnessId[], work: (agent: HarnessId) => Promise<void>): Promise<ConnectorList["unavailable"]> {
    const failed: ConnectorList["unavailable"] = [];
    for (const agent of agents) {
      await work(agent).catch((error: unknown) => failed.push({ agent, reason: readableConnectorError(error instanceof Error ? error.message : String(error)) }));
    }
    return failed;
  }

  /** What every place said is stale after a change: the next look reads again, and every open list asks. */
  private forget(): void {
    this.generation += 1;
    for (const entry of this.readings.values()) if (entry.value) entry.value.at = 0;
    this.changed();
  }

  /** For servers that send no image, looks on their makers' sites behind the list, and shows what it finds. */
  private lookForSiteLogos(rows: Reading["rows"]): void {
    const sites = connectorSites(rows);
    const sources = mergeConnectors(rows, this.logos).flatMap((connector) => {
      const source = connector.logo ? null : logoSource(connector.title, sites.get(connector.name) ?? []);
      return source ? [source] : [];
    });
    void this.siteLogos.look(sources).then((found) => found && this.changed());
  }

  private async fetchLogos(sources: string[]): Promise<void> {
    await Promise.all(
      [...new Set(sources)].map((src) => {
        if (this.logos.has(src)) return undefined;
        if (DATA_IMAGE.test(src)) {
          if (src.length <= LOGO_BYTES * 1.4) this.logos.set(src, src);
          return undefined;
        }
        const pending =
          this.fetchingLogos.get(src) ??
          iconImage(src)
            .then((image) => {
              if (image) this.logos.set(src, image);
            })
            .catch(() => undefined)
            .finally(() => this.fetchingLogos.delete(src));
        this.fetchingLogos.set(src, pending);
        return pending;
      }),
    );
  }
}

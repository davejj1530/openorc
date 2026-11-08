import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ConnectorDriver, ConnectorRow } from "@openorc/agents";
import type { AppSettings, Connector, ConnectorSpec } from "@openorc/protocol";
import { ConnectorService, type ConnectorDrivers } from "./connectors.js";
import type { RememberedConnectors } from "./remembered-connectors.js";
import type { AppSettingsService } from "./settings.js";

/** Where each host resolves; any other name is not found. */
const resolved = vi.hoisted(() => new Map<string, string>());
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const address = resolved.get(host);
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  },
}));

const row = (name: string, status: ConnectorRow["status"], extra: Partial<ConnectorRow> = {}): ConnectorRow => ({ name, title: name, source: "user", kind: "url", status, icons: [], ...extra });

function fakeDriver(rows: ConnectorRow[], calls: string[], label: string): ConnectorDriver {
  return {
    read: async () => rows,
    spec: async () => null,
    save: async (name) => void calls.push(`${label} save ${name}`),
    remove: async (name) => void calls.push(`${label} remove ${name}`),
    signIn: async (name, _folder, open) => {
      calls.push(`${label} signIn ${name}`);
      open(`https://example.test/${label}`);
    },
    signOut: async (name) => void calls.push(`${label} signOut ${name}`),
  };
}

/** The makers' sites, as tests give them: the images each source finds, and every look asked for. */
function fakeSiteLogos(images: Record<string, string> = {}) {
  const looked: string[] = [];
  const key = (source: { site: string } | { icon: string } | null) => {
    if (!source) return "";
    return "site" in source ? source.site : source.icon;
  };
  return {
    looked,
    get: (source: { site: string } | { icon: string } | null) => images[key(source)] ?? null,
    look: async (sources: readonly ({ site: string } | { icon: string })[]) => {
      looked.push(...sources.map(key));
      return sources.some((source) => images[key(source)]);
    },
  };
}

function setup(
  options: { claude?: Record<string, ConnectorRow[]>; codex?: ConnectorRow[]; settings?: Partial<AppSettings>; siteImages?: Record<string, string>; remembered?: RememberedConnectors } = {},
) {
  const siteLogos = fakeSiteLogos(options.siteImages);
  const calls: string[] = [];
  const opened: string[] = [];
  let settings = { claudeUserMcpServers: true, claudeConnectorsOff: [] as string[], ...options.settings } as AppSettings;
  const store = { get: () => settings, set: (patch: Partial<AppSettings>) => (settings = { ...settings, ...patch }) } as unknown as AppSettingsService;
  const claudeRows = options.claude ?? { main: [] };
  const drivers: ConnectorDrivers = {
    claude: (launch) => {
      const account = String(launch.env["ACCOUNT"]);
      const driver = fakeDriver(claudeRows[account] ?? [], calls, `claude:${account}`);
      return {
        ...driver,
        read: async () =>
          [...(claudeRows[account] ?? []), ...settings.claudeConnectorsOff.map((name) => row(name, "off"))].filter(
            (entry, index, all) => all.findIndex((other) => other.name === entry.name) === index,
          ),
      };
    },
    codex: () => ({ ...fakeDriver(options.codex ?? [], calls, "codex"), setOn: async (name, on) => void calls.push(`codex setOn ${name} ${on}`) }),
    opencode: () => {
      throw new Error("OpenCode was not found. Rescan after installing it.");
    },
  };
  const launch = (account: string) => ({ binary: "claude", env: { ACCOUNT: account } });
  const changed = vi.fn();
  const service = new ConnectorService(
    {
      claudeAccounts: () => Object.keys(claudeRows).map((id) => ({ id, name: `Account ${id}`, launch: launch(id) })),
      claudeLogin: () => launch("main"),
      codex: () => ({ binary: "codex", env: {} }),
      opencode: () => {
        throw new Error("OpenCode was not found. Rescan after installing it.");
      },
    },
    store,
    changed,
    { open: (url) => opened.push(url), drivers, siteLogos, ...(options.remembered ? { remembered: options.remembered } : {}) },
  );
  return { service, calls, opened, changed, siteLogos, settings: () => settings };
}

const spec: ConnectorSpec = { kind: "url", url: "https://paper.example/mcp", headers: {} };

describe("connectors", () => {
  it("answers a fresh start with the list last read in the folder, then reads again and keeps what it finds", async () => {
    const kept = new Map<string, Connector[]>();
    const remembered: RememberedConnectors = { load: (folder) => kept.get(folder) ?? null, save: (folder, connectors) => void kept.set(folder, connectors) };
    const first = setup({ claude: { main: [row("paper", "connected")] }, remembered });
    expect((await first.service.list("/project")).connectors.map((connector) => connector.name)).toEqual(["paper"]);

    const next = setup({ claude: { main: [row("paper", "connected"), row("rive", "connected")] }, remembered });
    const answered = await next.service.list("/project");
    expect(answered.connectors.map((connector) => connector.name)).toEqual(["paper"]);
    expect(answered.checking).toBe(true);
    await vi.waitFor(() => expect(next.changed).toHaveBeenCalled());
    expect((await next.service.list("/project")).connectors.map((connector) => connector.name)).toEqual(["paper", "rive"]);
    expect(kept.get("/project")?.map((connector) => connector.name)).toEqual(["paper", "rive"]);
    // Another folder has nothing remembered, so its first read is waited for.
    expect((await next.service.list("/elsewhere")).checking).toBe(false);
  });

  it("are one row per server, with each Claude account's status and an agent that is missing said once", async () => {
    const { service } = setup({ claude: { main: [row("paper", "connected")], work: [row("paper", "needs-sign-in")] }, codex: [row("paper", "connected", { source: "project" })] });
    const list = await service.list("/project");
    expect(list.connectors).toEqual([
      {
        name: "paper",
        title: "paper",
        kind: "url",
        logo: null,
        agents: [
          { agent: "codex", source: "project", editable: false, switchable: false, places: [{ status: "connected" }] },
          {
            agent: "claude",
            source: "user",
            editable: true,
            switchable: true,
            places: [
              { accountId: "main", accountName: "Account main", status: "connected" },
              { accountId: "work", accountName: "Account work", status: "needs-sign-in" },
            ],
          },
        ],
      },
    ]);
    expect(list.unavailable).toEqual([{ agent: "opencode", reason: "OpenCode was not found. Rescan after installing it." }]);
  });

  it("save to the agents chosen and leave the ones that lost it without it", async () => {
    const { service, calls } = setup({ claude: { main: [row("paper", "connected")] }, codex: [row("paper", "connected")] });
    await service.list("/project");
    await service.save({ name: "paper", previousName: "paper", spec, agents: ["claude"] });
    expect(calls).toEqual(["codex remove paper", "claude:main save paper"]);
  });

  it("rename by saving the new name and removing the old one", async () => {
    const { service, calls } = setup({ claude: { main: [row("paper", "connected")] } });
    await service.list("/project");
    await service.save({ name: "paper-mcp", previousName: "paper", spec, agents: ["claude"] });
    expect(calls).toEqual(["claude:main save paper-mcp", "claude:main remove paper"]);
  });

  it("turn Claude's off in OpenOrc's settings and another agent's in its own", async () => {
    const { service, calls, settings } = setup({ claude: { main: [row("paper", "connected")] }, codex: [row("paper", "connected")] });
    await service.setOn("claude", "paper", false);
    await service.setOn("codex", "paper", false);
    expect(settings().claudeConnectorsOff).toEqual(["paper"]);
    expect(calls).toEqual(["codex setOn paper false"]);
    await service.setOn("claude", "paper", true);
    expect(settings().claudeConnectorsOff).toEqual([]);
  });

  it("sign in one place at a time, everywhere it is still needed", async () => {
    const { service, calls, opened, changed } = setup({
      claude: { main: [row("mobbin", "connected")], work: [row("mobbin", "needs-sign-in")], home: [row("mobbin", "needs-sign-in")] },
      codex: [row("mobbin", "needs-sign-in")],
    });
    await service.list();
    expect(service.signInEverywhere("mobbin")).toEqual({ started: true });
    expect(service.signInEverywhere("mobbin")).toEqual({ started: false });
    await vi.waitFor(() => expect(service.hasPendingWork).toBe(false));
    expect(calls).toEqual(["codex signIn mobbin", "claude:work signIn mobbin", "claude:home signIn mobbin"]);
    expect(opened).toEqual(["https://example.test/codex", "https://example.test/claude:work", "https://example.test/claude:home"]);
    expect(changed).toHaveBeenCalled();
  });

  it("turn the old all-or-nothing switch into one switch per Claude server, once", async () => {
    const { service, settings } = setup({ claude: { main: [row("paper", "connected"), row("claude.ai Figma", "connected", { source: "account" })] }, settings: { claudeUserMcpServers: false } });
    await service.list();
    expect(settings().claudeUserMcpServers).toBe(true);
    expect(settings().claudeConnectorsOff).toEqual(["paper", "claude.ai Figma"]);
  });

  it("keep a logo the server sent as image data and skip anything else", async () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const { service } = setup({ claude: { main: [row("figma", "connected", { icons: [image] }), row("odd", "connected", { icons: ["data:text/html;base64,PHA+"] })] } });
    const list = await service.list();
    expect(list.connectors.map((connector) => [connector.name, connector.logo])).toEqual([
      ["figma", image],
      ["odd", null],
    ]);
  });

  it("ask for the image a server names only on the public web", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      asked.push(url.href);
      return new Response(png, { headers: { "content-type": "image/png" } });
    });
    onTestFinished(() => void vi.unstubAllGlobals());
    resolved.set("cdn.example.com", "93.184.216.34").set("rebound.example.com", "10.0.0.5");
    const { service } = setup({
      claude: {
        main: [
          row("lan", "connected", { icons: ["https://192.168.1.2/logo.png"] }),
          row("rebound", "connected", { icons: ["https://rebound.example.com/logo.png"] }),
          row("cdn", "connected", { icons: ["https://cdn.example.com/logo.png"] }),
        ],
      },
    });
    const list = await service.list();
    expect(asked).toEqual(["https://cdn.example.com/logo.png"]);
    expect(list.connectors.map((connector) => [connector.name, connector.logo])).toEqual([
      ["cdn", `data:image/png;base64,${Buffer.from(png).toString("base64")}`],
      ["lan", null],
      ["rebound", null],
    ]);
  });

  it("look for an image on the maker's site of a server that sends none, from its address or a known name, and show it once found", async () => {
    const image = "data:image/svg+xml;base64,PHN2Zy8+";
    const { service, siteLogos, changed } = setup({
      claude: { main: [row("linear", "connected", { site: "mcp.linear.app" }), row("claude.ai Gmail", "connected", { title: "Gmail", kind: null }), row("local", "connected", { site: "127.0.0.1" })] },
      siteImages: { "linear.app": image },
    });
    await service.list();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(siteLogos.looked).toEqual(["https://ssl.gstatic.com/images/branding/product/2x/gmail_2020q4_32dp.png", "linear.app"]);
    expect((await service.list()).connectors.map((connector) => [connector.name, connector.logo])).toEqual([
      ["claude.ai Gmail", null],
      ["linear", image],
      ["local", null],
    ]);
  });

  it("read again after a change that landed while a read was under way", async () => {
    const calls: string[] = [];
    let status: ConnectorRow["status"] = "connected";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service } = setup({ claude: { main: [] } });
    const reads = { count: 0 };
    (service as unknown as { drivers: ConnectorDrivers }).drivers.codex = () => ({
      ...fakeDriver([], calls, "codex"),
      read: async () => {
        reads.count += 1;
        const seen = status;
        if (reads.count === 2) await gate;
        return [row("paper", seen)];
      },
      setOn: async (_name, on) => void (status = on ? "connected" : "off"),
    });
    await service.list("/project");
    const reading = service.list("/project", true);
    await vi.waitFor(() => expect(reads.count).toBe(2));
    await service.setOn("codex", "paper", false);
    release();
    await reading;
    await vi.waitFor(async () => expect((await service.list("/project")).connectors[0]?.agents[0]?.places[0]?.status).toBe("off"));
  });

  it("save only to the agents involved, so one that is not installed is no failure", async () => {
    const { service, calls } = setup({ claude: { main: [] } });
    await service.list();
    expect(await service.save({ name: "paper", spec, agents: ["claude"] })).toEqual({ failed: [] });
    expect(calls).toEqual(["claude:main save paper"]);
  });

  it("refuse to add, or rename onto, a name already in use", async () => {
    const { service, calls } = setup({ claude: { main: [row("github", "connected"), row("paper", "connected")] } });
    await service.list();
    await expect(service.save({ name: "github", spec, agents: ["codex"] })).rejects.toThrow("A connector named github already exists.");
    await expect(service.save({ name: "github", previousName: "paper", spec, agents: ["claude"] })).rejects.toThrow("already exists");
    await service.save({ name: "github", previousName: "github", spec, agents: ["claude"] });
    expect(calls).toEqual(["claude:main save github"]);
  });

  it("carry a turned-off switch to the new name on a rename", async () => {
    const { service, settings } = setup({ claude: { main: [row("paper", "connected")] }, settings: { claudeConnectorsOff: ["paper"] } });
    await service.list();
    await service.save({ name: "paper-mcp", previousName: "paper", spec, agents: ["claude"] });
    expect(settings().claudeConnectorsOff).toEqual(["paper-mcp"]);
  });

  it("drop a removed connector from the list at once, before the next read", async () => {
    const { service } = setup({ claude: { main: [row("paper", "connected")] }, codex: [row("paper", "connected", { source: "project" })] });
    await service.list("/project");
    await service.remove("paper");
    const agents = (await service.list("/project")).connectors.find((connector) => connector.name === "paper")?.agents.map((agent) => agent.agent);
    expect(agents).toEqual(["codex"]);
  });
});

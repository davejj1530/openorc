/**
 * The stand-in's GitHub, as the real server's github and projects controllers answer an app in the selected space:
 *   starting an install for an app on a loopback port answers GitHub's page: linking the person's account first when
 *   they have not, then installing OpenOrc's app; a page's state is good once, for the person it was made for
 *   GitHub returns the browser to the server, which sends it on to the app's port with GitHub's query
 *   (`returnFor`, as the person going through the page would); the app posts that query to finish the step
 *   an install connects the repositories `grant` names, which GET /github/repositories then lists
 *   DELETE /github/account unlinks the person; POST /projects makes granted repositories projects of the space, and a
 *   repository already one answers that project
 */
import { randomBytes } from "node:crypto";
import { GithubConnectChoice } from "@openorc/protocol";
import type { StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };

interface Person {
  login: string | null;
  /** What GitHub lets the app read once the person installs it. */
  granted: { repositories: string[] } & Grant;
}
interface Grant {
  id?: number;
  accountLogin?: string;
  accountType?: "User" | "Organization";
  settingsUrl?: string | null;
}
interface Installation {
  owner: string;
  space: string;
  installationId: number;
  id: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  settingsUrl: string | null;
  repositories: { fullName: string; repoId: number }[];
}

const PAGE_MS = 15 * 60_000;

export class StandInGithub {
  readonly #people = new Map<string, Person>();
  readonly #installations = new Map<string, Installation>();
  readonly #states = new Map<string, { who: string; step: "link" | "install"; port: number; space: string }>();
  #repoIds = 0;
  configured = true;

  constructor(
    private readonly spaces: StandInSpaces,
    private readonly projectsChanged: (who: string) => void,
  ) {}

  /** The repositories GitHub lets OpenOrc read once this person installs its app, as owner/name. */
  grant(who: string, repositories: string[], options: Grant = {}): void {
    this.#person(who).granted = { repositories, ...options };
    for (const installed of this.#installations.values()) {
      if (installed.owner !== who || installed.installationId !== (options.id ?? 7001)) continue;
      installed.repositories = repositories.map((fullName) => installed.repositories.find((repository) => repository.fullName === fullName) ?? { fullName, repoId: ++this.#repoIds });
      if (options.settingsUrl !== undefined) installed.settingsUrl = options.settingsUrl;
    }
  }

  /**
   * Where GitHub's page sends the browser, through the server, for a person who went through it: the app's loopback
   * with GitHub's query. `denied`: they cancelled on GitHub.
   */
  returnFor(url: string, options: { denied?: boolean } = {}): string {
    const state = new URL(url).searchParams.get("state") ?? "";
    const page = this.#states.get(state);
    if (!page) throw new Error("No such GitHub page.");
    const linked = options.denied ? "error=access_denied" : "code=granted";
    const query = `${page.step === "link" ? linked : `installation_id=${this.#person(page.who).granted.id ?? 7001}&setup_action=install`}&state=${state}`;
    return `http://127.0.0.1:${page.port}/github-return?${query}`;
  }

  route(method: string, path: string, who: string, body: Record<string, unknown>, named: string | null = null): Reply | null {
    const person = this.#person(who);
    const removing = method === "DELETE" && /^\/projects\/[^/]+$/.test(path);
    if (!(path.startsWith("/github") || (method === "POST" && path === "/projects") || removing)) return null;
    const space = this.spaces.resolve(who, named);
    if (typeof space !== "string") return space;
    if ((removing || ["/github", "/github/repositories", "/github/install/start", "/projects"].includes(path)) && space !== `personal-${who}` && this.spaces.member(space, who)?.role !== "admin")
      return { status: 403, body: { message: "Only an admin can do that." } };
    const installed = [...this.#installations.values()].filter((installation) => installation.space === space);
    const routes: Record<string, () => Reply> = {
      "GET /github": () => ({
        status: 200,
        body: {
          configured: this.configured,
          installations: installed.map(({ id, accountLogin, accountType, settingsUrl }) => ({ id, accountLogin, accountType, suspended: false, settingsUrl: this.configured ? settingsUrl : null })),
          available: person.login && this.configured ? this.#available(who, space) : [],
        },
      }),
      "GET /github/account": () => ({ status: 200, body: { configured: this.configured, account: person.login ? { login: person.login, name: null } : null } }),
      "GET /github/repositories": () => ({
        status: 200,
        body: installed.flatMap((installation) => installation.repositories.map((repository) => ({ installationId: installation.id, ...repository, defaultBranch: "main", private: true }))),
      }),
      "POST /github/install/start": () => this.#start(who, person, Number(body["port"]), space, body),
      "POST /github/link/finish": () => this.#finish(who, "link", String(body["query"] ?? "")),
      "POST /github/install/finish": () => this.#finish(who, "install", String(body["query"] ?? "")),
      "DELETE /github/account": () => {
        person.login = null;
        return { status: 204, body: null };
      },
      "POST /projects": () => this.#addProjects(who, body, space),
    };
    const removed = method === "DELETE" ? /^\/projects\/([^/]+)$/.exec(path)?.[1] : undefined;
    if (removed) return this.#removeProject(who, decodeURIComponent(removed), space);
    return routes[`${method} ${path}`]?.() ?? null;
  }

  #available(who: string, space: string) {
    const installed = [...this.#installations.values()];
    const here = new Set(installed.filter((installation) => installation.space === space).map((installation) => installation.installationId));
    return [
      ...new Map(
        installed
          .filter((installation) => installation.owner === who && !here.has(installation.installationId))
          .map(({ installationId, accountLogin, accountType }) => [installationId, { installationId, accountLogin, accountType }]),
      ).values(),
    ];
  }

  #start(who: string, person: Person, port: number, space: string, body: Record<string, unknown>): Reply {
    const parsed = GithubConnectChoice.safeParse({ another: body["another"], installationId: body["installationId"] });
    if (!parsed.success || (parsed.data.another && parsed.data.installationId !== undefined)) return { status: 400, body: { message: "Choose one GitHub account to connect." } };
    const choice = parsed.data;
    if (person.login && !choice.another) {
      const settled = this.#chosen(who, space, choice.installationId);
      if (settled) return settled;
    }
    const step = person.login ? "install" : "link";
    const state = randomBytes(12).toString("hex");
    this.#states.set(state, { who, step, port, space });
    const url = step === "link" ? `https://github.com/login/oauth/authorize?client_id=openorc&state=${state}` : `https://github.com/apps/openorc/installations/new?state=${state}`;
    return { status: 200, body: { kind: "github", step, url, expiresInMs: PAGE_MS } };
  }

  #chosen(who: string, space: string, installationId: number | undefined): Reply | null {
    const owned = [...this.#installations.values()].filter((installation) => installation.owner === who);
    if (installationId === undefined) return owned.length ? { status: 200, body: { kind: "choose", available: this.#available(who, space) } } : null;
    const installation = owned.find((each) => each.installationId === installationId);
    if (!installation) return { status: 200, body: { kind: "settled", outcome: "unverified" } };
    const key = `${space}:${installationId}`;
    if (!this.#installations.has(key)) this.#installations.set(key, { ...installation, space, id: randomBytes(12).toString("hex") });
    this.projectsChanged(who);
    return { status: 200, body: { kind: "settled", outcome: "connected" } };
  }

  #finish(who: string, step: "link" | "install", query: string): Reply {
    const params = new URLSearchParams(query);
    const state = params.get("state") ?? "";
    const page = this.#states.get(state);
    this.#states.delete(state);
    if (!page || page.who !== who || page.step !== step) return { status: 200, body: { outcome: "expired" } };
    const person = this.#person(who);
    if (step === "link") {
      if (params.get("error")) return { status: 200, body: { outcome: "denied" } };
      person.login = who.split("@")[0]!;
      return { status: 200, body: { outcome: "linked" } };
    }
    return this.#install(who, page.space, Number(params.get("installation_id")));
  }

  #install(who: string, space: string, id: number): Reply {
    const person = this.#person(who);
    const key = `${space}:${id}`;
    const prior = this.#installations.get(key);
    const managed = [...this.#installations.values()].find((installation) => installation.installationId === id);
    if (id !== (person.granted.id ?? 7001) || (managed && managed.owner !== who)) return { status: 200, body: { outcome: "unverified" } };
    this.#installations.set(key, {
      owner: who,
      space,
      id: prior?.id ?? randomBytes(12).toString("hex"),
      installationId: id,
      accountLogin: person.granted.accountLogin ?? person.login ?? "github",
      accountType: person.granted.accountType ?? "User",
      settingsUrl: person.granted.settingsUrl === undefined ? `https://github.com/settings/installations/${id}` : person.granted.settingsUrl,
      repositories: person.granted.repositories.map((fullName) => prior?.repositories.find((repository) => repository.fullName === fullName) ?? { fullName, repoId: ++this.#repoIds }),
    });
    this.projectsChanged(who);
    return { status: 200, body: { outcome: "connected" } };
  }

  #removeProject(who: string, id: string, space: string): Reply {
    if (!this.spaces.removeProject(space, id)) return { status: 404, body: { message: "That project isn't here.", statusCode: 404 } };
    this.projectsChanged(who);
    return { status: 204, body: null };
  }

  #addProjects(who: string, body: Record<string, unknown>, space: string): Reply {
    const asked = (body["repositories"] ?? []) as { installationId: string; repoId: number }[];
    const made = asked.map(({ installationId, repoId }) => {
      const installation = [...this.#installations.values()].find((each) => each.id === installationId && each.space === space);
      const repository = installation?.repositories.find((each) => each.repoId === repoId);
      return repository ? this.spaces.ensureProject(space, { ...repository, defaultBranch: "main" }) : null;
    });
    if (made.includes(null)) return { status: 404, body: { message: "OpenOrc can't read that repository. Check the app's access on GitHub.", statusCode: 404 } };
    this.projectsChanged(who);
    return { status: 201, body: made.map((project) => ({ ...project, connected: true })) };
  }

  #person(who: string): Person {
    let person = this.#people.get(who);
    if (!person) this.#people.set(who, (person = { login: null, granted: { repositories: [] } }));
    return person;
  }
}

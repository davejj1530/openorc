/**
 * The stand-in's GitHub, as the real server's github and projects controllers answer an app, for the person's personal
 * space (the active one):
 *   starting an install for an app on a loopback port answers GitHub's page: linking the person's account first when
 *   they have not, then installing OpenOrc's app; a page's state is good once, for the person it was made for
 *   GitHub returns the browser to the server, which sends it on to the app's port with GitHub's query
 *   (`returnFor`, as the person going through the page would); the app posts that query to finish the step
 *   an install connects the repositories `grant` names, which GET /github/repositories then lists
 *   DELETE /github/account unlinks the person; POST /projects makes granted repositories projects of the space, and a
 *   repository already one answers that project
 */
import { randomBytes } from "node:crypto";
import type { StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };

interface Person {
  login: string | null;
  installed: { space: string; id: string; login: string; repositories: { fullName: string; repoId: number }[] } | null;
  /** What GitHub lets the app read once the person installs it. */
  granted: string[];
}

const PAGE_MS = 15 * 60_000;

export class StandInGithub {
  readonly #people = new Map<string, Person>();
  readonly #states = new Map<string, { who: string; step: "link" | "install"; port: number; space: string }>();
  #repoIds = 0;
  configured = true;

  constructor(
    private readonly spaces: StandInSpaces,
    private readonly projectsChanged: (who: string) => void,
  ) {}

  /** The repositories GitHub lets OpenOrc read once this person installs its app, as owner/name. */
  grant(who: string, repositories: string[]): void {
    this.#person(who).granted = repositories;
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
    const query = `${page.step === "link" ? linked : "installation_id=7001&setup_action=install"}&state=${state}`;
    return `http://127.0.0.1:${page.port}/github-return?${query}`;
  }

  route(method: string, path: string, who: string, body: Record<string, unknown>, named: string | null = null): Reply | null {
    const person = this.#person(who);
    if (!(path.startsWith("/github") || (method === "POST" && path === "/projects"))) return null;
    const space = this.spaces.resolve(who, named);
    if (typeof space !== "string") return space;
    if (["/github", "/github/repositories", "/github/install/start", "/projects"].includes(path) && space !== `personal-${who}` && this.spaces.member(space, who)?.role !== "admin")
      return { status: 403, body: { message: "Only an admin can do that." } };
    const installed = person.installed?.space === space ? person.installed : null;
    const routes: Record<string, () => Reply> = {
      "GET /github": () => ({
        status: 200,
        body: { configured: this.configured, installations: installed ? [{ id: installed.id, accountLogin: installed.login, accountType: "User", suspended: false }] : [] },
      }),
      "GET /github/account": () => ({ status: 200, body: { configured: this.configured, account: person.login ? { login: person.login, name: null } : null } }),
      "GET /github/repositories": () => ({
        status: 200,
        body: (installed?.repositories ?? []).map((repository) => ({ installationId: installed!.id, ...repository, defaultBranch: "main", private: true })),
      }),
      "POST /github/install/start": () => this.#start(who, person, Number(body["port"]), space),
      "POST /github/link/finish": () => this.#finish(who, "link", String(body["query"] ?? "")),
      "POST /github/install/finish": () => this.#finish(who, "install", String(body["query"] ?? "")),
      "DELETE /github/account": () => {
        person.login = null;
        return { status: 204, body: null };
      },
      "POST /projects": () => this.#addProjects(who, person, body, space),
    };
    return routes[`${method} ${path}`]?.() ?? null;
  }

  #start(who: string, person: Person, port: number, space: string): Reply {
    if (person.installed && person.installed.space !== space) return { status: 200, body: { kind: "settled", outcome: "taken" } };
    const step = person.login ? "install" : "link";
    const state = randomBytes(12).toString("hex");
    this.#states.set(state, { who, step, port, space });
    const url = step === "link" ? `https://github.com/login/oauth/authorize?client_id=openorc&state=${state}` : `https://github.com/apps/openorc/installations/new?state=${state}`;
    return { status: 200, body: { kind: "github", step, url, expiresInMs: PAGE_MS } };
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
    person.installed = { space: page.space, id: "installation-7001", login: person.login ?? "github", repositories: person.granted.map((fullName) => ({ fullName, repoId: ++this.#repoIds })) };
    this.projectsChanged(who);
    return { status: 200, body: { outcome: "connected" } };
  }

  #addProjects(who: string, person: Person, body: Record<string, unknown>, space: string): Reply {
    const asked = (body["repositories"] ?? []) as { installationId: string; repoId: number }[];
    const made = asked.map(({ installationId, repoId }) => {
      const repository = person.installed?.id === installationId && person.installed.space === space ? person.installed.repositories.find((each) => each.repoId === repoId) : undefined;
      return repository ? this.spaces.ensureProject(space, { ...repository, defaultBranch: "main" }) : null;
    });
    if (made.includes(null)) return { status: 404, body: { message: "OpenOrc can't read that repository. Check the app's access on GitHub.", statusCode: 404 } };
    this.projectsChanged(who);
    return { status: 201, body: made.map((project) => ({ ...project, connected: true })) };
  }

  #person(who: string): Person {
    let person = this.#people.get(who);
    if (!person) this.#people.set(who, (person = { login: null, installed: null, granted: [] }));
    return person;
  }
}

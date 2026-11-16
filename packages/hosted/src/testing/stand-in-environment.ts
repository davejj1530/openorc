/**
 * A cloud project's own environment variables, as the server keeps them: values sealed and never read back, names and
 * times for anyone who can use the project, changes for a team's admins and a Personal space's owner. While the
 * `projectEnvironment` capability is not on, every route answers 409 with its reason, as the server does behind its switch.
 */
import type { StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };

const OFF = "A project's environment isn't available in cloud threads yet.";
const PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "OPENCODE_", "OPENROUTER_", "OPENORC_", "XDG_", "GIT_AUTHOR_", "GIT_COMMITTER_", "LD_", "DYLD_"];
const NAMES = [
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
];
const refused = (status: number, message: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { statusCode: status, message, ...extra } });

/** Why a name can't be a variable's, in the server's sentence; null when it can. */
function nameProblem(name: string): string | null {
  if (!name) return "Give the variable a name.";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "Use letters, digits and underscores.";
  if (name.length > 128) return "Keep the name under 128 characters.";
  if (NAMES.includes(name)) return `${name} is set by the cloud machine.`;
  const prefix = PREFIXES.find((each) => name.startsWith(each));
  return prefix ? `${prefix} names are kept for the agents.` : null;
}

export class StandInEnvironment {
  readonly #kept = new Map<string, Map<string, { value: string; updatedAt: string }>>();

  constructor(private readonly deps: { spaces: StandInSpaces; available(): boolean }) {}

  /** What a project's variables hold, for a test to read what a save kept. */
  values(projectId: string): Record<string, string> {
    return Object.fromEntries([...(this.#kept.get(projectId) ?? [])].map(([name, kept]) => [name, kept.value]));
  }

  route(request: Request, who: string, body: unknown): Reply | null {
    const [, projectId, named] = /^\/hosted\/projects\/([^/]+)\/environment(?:\/([^/]+))?$/.exec(request.path) ?? [];
    if (!projectId) return null;
    if (!this.deps.available()) return refused(409, OFF, { code: "feature_unavailable" });
    const space = this.deps.spaces.resolve(who, request.space);
    if (typeof space !== "string") return space;
    if (!this.deps.spaces.project(space, projectId) || !this.deps.spaces.canRead(space, projectId, who)) return refused(404, "Project not found");
    const canChange = space.startsWith("personal-") || this.deps.spaces.member(space, who)?.role === "admin";
    if (request.method === "GET" && !named) return this.#listed(projectId, canChange);
    if (request.method !== (named ? "DELETE" : "PUT")) return refused(404, `Cannot ${request.method} ${request.path}`);
    if (!canChange) return refused(403, "Only an admin can change a project's environment.");
    if (named) {
      this.#kept.get(projectId)?.delete(decodeURIComponent(named));
      return this.#listed(projectId, true);
    }
    return this.#put(projectId, body);
  }

  #put(projectId: string, body: unknown): Reply {
    const variables = (body as { variables?: { name: string; value: string }[] } | null)?.variables;
    if (!Array.isArray(variables) || !variables.length) return refused(400, "variables: Set a variable to save.");
    if (new Set(variables.map((variable) => variable.name)).size !== variables.length) return refused(400, "variables: Name each variable once.");
    for (const { name } of variables) {
      const problem = nameProblem(name);
      if (problem) return refused(400, problem, { code: "environment_name_refused", name });
    }
    if (variables.some((variable) => Buffer.byteLength(variable.value) > 32 * 1024)) return refused(400, "variables: Keep a value under 32 KB.");
    const updatedAt = new Date().toISOString();
    const kept = this.#kept.get(projectId) ?? new Map<string, { value: string; updatedAt: string }>();
    this.#kept.set(projectId, kept);
    for (const { name, value } of variables) kept.set(name, { value, updatedAt });
    return this.#listed(projectId, true);
  }

  #listed(projectId: string, canChange: boolean): Reply {
    const variables = [...(this.#kept.get(projectId) ?? [])].map(([name, kept]) => ({ name, updatedAt: kept.updatedAt })).sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: { variables, canChange } };
  }
}

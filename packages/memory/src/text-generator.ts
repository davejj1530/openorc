import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { agentBinary, launchCommand } from "@openorc/agents";
import type { HarnessId } from "@openorc/protocol";

const TITLE_PROMPT = `Name this conversation between a user and a coding agent.
Return ONLY minified JSON, no prose, no code fences: {"title":string}
Rules: 2 to 4 words and at most 28 characters, sentence case, no quotes and no trailing period. Name the subject, not the request: "Sidebar traffic lights", not "Fix the sidebar".`;

/** Codex enforces this schema on the title reply. */
const TITLE_SCHEMA = { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } };

export type TextGenerationProvider = HarnessId;

export interface TextGeneratorOptions {
  provider?: TextGenerationProvider;
  model?: string;
  /** Claude only: bill an Anthropic API key instead of the user's subscription. */
  apiKey?: string;
  binary?: string;
  /** Complete immutable environment paired with `binary` by the core. */
  env?: Readonly<NodeJS.ProcessEnv>;
  timeoutMs?: number;
  /** Limit reasoning on small background jobs without changing distillation. */
  effort?: "low";
  /**
   * Who the agent is for a job whose whole input is the prompt. On Claude it replaces Claude Code's agent prompt: with no
   * tools and no extended thinking the answer comes straight back; offered tools, a model reaches for a file it already
   * has. Codex takes it as its developer instructions, and OpenCode and Oh My Pi as their agent's prompt.
   */
  system?: string;
}

interface SpawnInput {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  read: (stdout: string) => string | null | Promise<string | null>;
  stdin?: string;
}

/** Shared one-shot CLI runner for small background text jobs. */
export class TextGenerator {
  constructor(private readonly options: TextGeneratorOptions = {}) {}

  /** A short name for a thread from its first exchange, or null when the model cannot be reached. */
  async title(exchange: { request: string; reply: string | null }): Promise<string | null> {
    const prompt = [TITLE_PROMPT, "", `User: ${clip(exchange.request, 1500)}`, ...(exchange.reply ? [``, `Assistant: ${clip(exchange.reply, 1500)}`] : [])].join("\n");
    const raw = await this.ask(prompt, TITLE_SCHEMA);
    return raw ? parseTitle(raw) : null;
  }

  /**
   * A one-shot answer to a prompt that asks for JSON. Codex is held to `schema`; the others follow the prompt. Null when
   * the model cannot be reached. `pictures` is a folder the caller made: what the agent draws while answering lands there,
   * on a harness whose catalog entry says it makes pictures.
   */
  complete(prompt: string, schema: object, pictures?: string): Promise<string | null> {
    return this.ask(prompt, schema, pictures);
  }

  /** Each harness needs its own one-shot invocation; a harness without one cannot generate text. */
  protected ask(prompt: string, schema: object, pictures?: string): Promise<string | null> {
    const runners: Record<HarnessId, () => Promise<string | null>> = {
      claude: () => this.runClaude(prompt),
      codex: () => this.runCodex(prompt, schema, pictures),
      opencode: () => this.runOpenCode(prompt),
      omp: () => this.runOmp(prompt),
      cursor: () => Promise.resolve(null),
      pi: () => Promise.resolve(null),
      antigravity: () => Promise.resolve(null),
      fx: () => Promise.resolve(null),
    };
    return runners[this.options.provider ?? "claude"]();
  }

  /** The prompt goes over stdin, like the other harnesses', so conversation text never appears in a command line other accounts can read. */
  private runClaude(prompt: string): Promise<string | null> {
    const binary = this.options.binary ?? agentBinary("claude");
    const model = this.options.model ?? "claude-haiku-4-5-20251001";
    // Only the user's own settings: project settings come from the working folder, which is not the user's project here.
    const { system } = this.options;
    const tools = system === undefined ? ["--disallowed-tools", "Bash", "Edit", "Write", "WebFetch", "WebSearch"] : ["--tools", "", "--system-prompt", system];
    const args = ["-p", "--model", model, "--output-format", "json", "--max-turns", "1", "--setting-sources", "user", "--strict-mcp-config", ...tools];
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    delete env["CLAUDECODE"];
    if (system !== undefined) env["MAX_THINKING_TOKENS"] = "0";
    if (this.options.apiKey) env["ANTHROPIC_API_KEY"] = this.options.apiKey;
    return this.spawn({
      binary,
      args,
      env,
      read: (stdout) => {
        const parsed = JSON.parse(stdout) as { result?: string };
        return typeof parsed.result === "string" ? parsed.result : null;
      },
      stdin: prompt,
    });
  }

  /**
   * Codex exec in a read-only sandbox with the user's MCP servers disabled, so
   * generation never touches the repo or third-party tools. The final
   * message lands in a temp file because stdout carries progress output.
   * A run that may draw prints its events instead, which name the session
   * whose pictures are then taken.
   */
  private async runCodex(prompt: string, schema: object, pictures?: string): Promise<string | null> {
    const binary = this.options.binary ?? agentBinary("codex");
    const dir = await mkdtemp(join(tmpdir(), "openorc-distill-"));
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "last.txt");
    try {
      await writeFile(schemaPath, JSON.stringify(schema));
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "mcp_servers={}", "--output-schema", schemaPath, "-o", outPath, "-"];
      if (pictures) args.splice(1, 0, "--json");
      if (this.options.system !== undefined) args.splice(1, 0, "-c", `developer_instructions=${JSON.stringify(this.options.system)}`);
      if (this.options.effort) args.splice(1, 0, "-c", `model_reasoning_effort="${this.options.effort}"`);
      if (this.options.model) args.splice(1, 0, "--model", this.options.model);
      const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), NO_COLOR: "1" };
      const read = async (stdout: string) => {
        if (pictures) await takeCodexPictures(stdout, env, pictures);
        return (await readFile(outPath, "utf8")).trim() || null;
      };
      return await this.spawn({ binary, args, env, read, stdin: prompt });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private runOpenCode(prompt: string): Promise<string | null> {
    // Require an explicit resolved model: OpenCode's conversation default may be expensive.
    if (!this.options.model) return Promise.resolve(null);
    const binary = this.options.binary ?? agentBinary("opencode");
    const agent = "openorc-text-generation";
    const args = ["run", "--standalone", "--format", "json", "--model", this.options.model, "--agent", agent, "--title", "Background text generation"];
    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: "disabled",
        permission: "deny",
        agent: { [agent]: { mode: "primary", steps: 1, permission: "deny", prompt: this.options.system ?? "Return only the text requested by the user. Do not use tools." } },
      }),
    };
    return this.spawn({
      binary,
      args,
      env,
      read: (stdout) => {
        const parts: string[] = [];
        for (const line of stdout.split("\n").filter((line) => line.trim())) {
          const event = JSON.parse(line) as { type?: string; part?: { text?: string } };
          if (event.type === "error") return null;
          if (event.type === "text" && typeof event.part?.text === "string") parts.push(event.part.text);
        }
        return parts.join("\n").trim() || null;
      },
      stdin: prompt,
    });
  }

  /**
   * Oh My Pi's print mode with no tools, extensions, skills, rules or context files, and no saved session: the prompt
   * in, the answer out. An explicit model avoids using an expensive default.
   */
  private runOmp(prompt: string): Promise<string | null> {
    if (!this.options.model) return Promise.resolve(null);
    const binary = this.options.binary ?? agentBinary("omp");
    const system = this.options.system ?? "Return only the text requested by the user. Do not use tools.";
    const args = [
      "-p",
      "--no-session",
      "--model",
      this.options.model,
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-context-files",
      "--no-lsp",
      "--no-title",
      "--system-prompt",
      system,
    ];
    if (this.options.effort) args.push("--thinking", this.options.effort);
    return this.spawn({ binary, args, env: { ...(this.options.env ?? process.env), NO_COLOR: "1" }, read: (stdout) => stdout.trim() || null, stdin: prompt });
  }

  /**
   * Each job runs in a folder of its own, made for it and removed after. The system temp folder is shared between
   * accounts on Linux, so settings or hooks someone else left there must never reach the agent.
   */
  private async spawn({ binary, args, env, read, stdin }: SpawnInput): Promise<string | null> {
    const cwd = await mkdtemp(join(tmpdir(), "openorc-text-"));
    try {
      return await new Promise<string | null>((resolve) => {
        try {
          const command = launchCommand(binary, args);
          const child = execFile(
            command.file,
            command.args,
            { ...command.options, env: { ...env, PWD: cwd }, cwd, timeout: this.options.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout) => {
              if (error && !stdout) {
                resolve(null);
                return;
              }
              Promise.resolve()
                .then(() => read(String(stdout)))
                .then(resolve, () => resolve(null));
            },
          );
          if (stdin !== undefined) child.stdin?.end(stdin);
          else child.stdin?.end();
        } catch {
          // A malformed or unavailable CLI invocation is an extraction fallback, not a run failure.
          resolve(null);
        }
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

/**
 * Codex keeps what a session draws in its home, in a folder named after the session, and names the session in the first
 * event it prints. The pictures move to `into`, numbered in the order drawn, so a one-shot leaves nothing behind in the
 * person's Codex.
 */
async function takeCodexPictures(events: string, env: NodeJS.ProcessEnv, into: string): Promise<void> {
  const started = events.split("\n", 1)[0] ?? "";
  const session = started.includes("thread.started") ? str((JSON.parse(started) as Record<string, unknown>)["thread_id"]) : "";
  // The name becomes a folder under Codex's home: only a plain id is followed there.
  if (!/^[\w-]+$/.test(session)) return;
  const drawn = join(env["CODEX_HOME"] || join(env["HOME"] || homedir(), ".codex"), "generated_images", session);
  const names = await readdir(drawn).catch(() => []);
  const made = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(drawn, name))).mtimeMs })));
  const inOrder = made.sort((a, b) => a.at - b.at);
  for (const [index, { name }] of inOrder.entries()) await copyFile(join(drawn, name), join(into, `picture-${index + 1}${extname(name)}`));
  await rm(drawn, { recursive: true, force: true });
}

export function parseTitle(raw: string): string | null {
  const cleaned = raw.replace(/```json\s*|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  let title = "";
  if (start >= 0 && end > start) {
    try {
      title = str((JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>)["title"]);
    } catch {
      title = "";
    }
  } else title = cleaned.split("\n")[0] ?? "";
  title = title
    .trim()
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019.]+$/g, "")
    .trim();
  return title.length > 0 ? title.slice(0, 80) : null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

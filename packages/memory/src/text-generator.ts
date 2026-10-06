import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBinary, launchCommand } from "@openorc/agents";
import type { HarnessId } from "@openorc/protocol";

const TITLE_PROMPT = `Name this conversation between a user and a coding agent.
Return ONLY minified JSON, no prose, no code fences: {"title":string}
Rules: 3 to 6 words, sentence case, no quotes and no trailing period. Name the subject, not the request: "Sidebar collapse and traffic lights", not "Fix the sidebar".`;

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

  /** Each harness needs its own one-shot invocation; a harness without one cannot generate text. */
  protected ask(prompt: string, schema: object): Promise<string | null> {
    const runners: Record<HarnessId, () => Promise<string | null>> = {
      claude: () => this.runClaude(prompt),
      codex: () => this.runCodex(prompt, schema),
      opencode: () => this.runOpenCode(prompt),
    };
    return runners[this.options.provider ?? "claude"]();
  }

  /** The prompt goes over stdin, like the other harnesses', so conversation text never appears in a command line other accounts can read. */
  private runClaude(prompt: string): Promise<string | null> {
    const binary = this.options.binary ?? agentBinary("claude");
    const model = this.options.model ?? "claude-haiku-4-5-20251001";
    // Only the user's own settings: project settings come from the working folder, which is not the user's project here.
    const args = [
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--disallowed-tools",
      "Bash",
      "Edit",
      "Write",
      "WebFetch",
      "WebSearch",
    ];
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    delete env["CLAUDECODE"];
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
   */
  private async runCodex(prompt: string, schema: object): Promise<string | null> {
    const binary = this.options.binary ?? agentBinary("codex");
    const dir = await mkdtemp(join(tmpdir(), "openorc-distill-"));
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "last.txt");
    try {
      await writeFile(schemaPath, JSON.stringify(schema));
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "mcp_servers={}", "--output-schema", schemaPath, "-o", outPath, "-"];
      if (this.options.effort) args.splice(1, 0, "-c", `model_reasoning_effort="${this.options.effort}"`);
      if (this.options.model) args.splice(1, 0, "--model", this.options.model);
      const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), NO_COLOR: "1" };
      return await this.spawn({ binary, args, env, read: () => readFile(outPath, "utf8").then((t) => t.trim() || null), stdin: prompt });
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
        agent: { [agent]: { mode: "primary", steps: 1, permission: "deny", prompt: "Return only the text requested by the user. Do not use tools." } },
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

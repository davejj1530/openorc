import { projects, type Db } from "@openorc/db";
import { AUTOMATION_CHECK_MINUTES, type CheckTry, type CheckWriting, type Project, type ThreadChoice } from "@openorc/protocol";
import { z } from "zod";
import { checkFinding, type AutomationSources } from "./automation-sources.js";
import type { TextGenerationService } from "./text-generation.js";

const SYSTEM = [
  "You write the check of an OpenOrc automation: a shell command that OpenOrc runs on a timer, with bash -lc in the project's folder on the person's Mac.",
  "Each line the command prints is one thing that happened, and the automation acts on each line once. So:",
  "- Print one line for each thing found, and nothing when there is nothing.",
  "- Begin each line with an id that tells one thing from another and stays the same each time it is printed, such as an issue's number, then a tab, then a few words a person can read.",
  "- List what is there each time. OpenOrc remembers the lines it has seen and acts only on new ones.",
  "- Only read. Never change, create, delete, post or send anything.",
  "- Finish within a minute. Use what a Mac has: bash, git, curl, and gh, GitHub's command line tool, for the project's GitHub repository.",
  "Choose how often it runs, in minutes from 1 to 10080: as often as what it watches needs, and no more.",
  'Answer with JSON: {"command":string,"everyMinutes":number,"problem":string}. Leave problem empty. When a command cannot watch for this, leave command empty and say why in problem, in one sentence.',
].join("\n");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["command", "everyMinutes", "problem"],
  properties: { command: { type: "string" }, everyMinutes: { type: "integer" }, problem: { type: "string" } },
};
const Answer = z.object({ command: z.string().trim().max(4000), everyMinutes: z.number(), problem: z.string().trim() });
/** How many times the agent writes the command: once, and once more told why the first did not run. */
const ATTEMPTS = 2;

type Written = { state: "written"; command: string; everyMinutes: number } | { state: "failed"; reason: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clampMinutes = (minutes: number) => Math.min(AUTOMATION_CHECK_MINUTES.max, Math.max(AUTOMATION_CHECK_MINUTES.min, Math.round(minutes)));

/** What the agent is told of the project: its name, and where its repository lives, which is where most checks look. */
function aboutProject(project: Project): string {
  const remote = project.gitRemote ? `Its git remote is ${project.gitRemote}` : "It has no git remote";
  return `The project is ${project.name}. ${remote}${project.defaultBranch ? `, and its main branch is ${project.defaultBranch}` : ""}.`;
}

function parsed(text: string): z.infer<typeof Answer> | null {
  try {
    return Answer.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Writes a check from what a person wants watched: an agent writes the command on the model the person chose, and it
 * runs once in the project's folder, so the person sees what it finds now. A command that does not run goes back to the
 * agent once, with why.
 */
export class CheckWriter {
  constructor(
    private readonly db: Db,
    private readonly deps: { text: Pick<TextGenerationService, "speak">; sources: AutomationSources },
  ) {}

  async try(projectId: string, command: string): Promise<CheckTry> {
    try {
      const lines = await this.deps.sources.check(this.project(projectId).rootPath, command);
      return { state: "ran", found: lines.map((line) => checkFinding(line).words) };
    } catch (error) {
      return { state: "failed", reason: errorText(error) };
    }
  }

  async write({ projectId, what, choice }: { projectId: string; what: string; choice: ThreadChoice }): Promise<CheckWriting> {
    const project = this.project(projectId);
    let prompt = `${aboutProject(project)}\n\nWhat to watch for: ${what}`;
    let last: { command: string; reason: string } | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const written = await this.ask(choice, prompt);
      if (written.state === "failed") return { state: "failed", reason: written.reason, command: last?.command ?? null };
      const tried = await this.try(projectId, written.command);
      if (tried.state === "ran") return { ...written, found: tried.found };
      last = { command: written.command, reason: tried.reason };
      prompt = `${prompt}\n\nThis command did not run:\n${written.command}\nIt said: ${tried.reason}\nWrite one that runs.`;
    }
    return { state: "failed", reason: `The check it wrote did not run. ${last?.reason ?? ""}`.trim(), command: last?.command ?? null };
  }

  private async ask(choice: ThreadChoice, prompt: string): Promise<Written> {
    const answer = await this.deps.text.speak({
      agent: choice.agent,
      model: choice.model,
      ...(choice.claudeAccountId ? { claudeAccountId: choice.claudeAccountId } : {}),
      system: SYSTEM,
      prompt,
      schema: SCHEMA,
    });
    if (answer.kind === "unavailable") return { state: "failed", reason: answer.reason };
    const read = answer.kind === "answered" ? parsed(answer.text) : null;
    if (!read) return { state: "failed", reason: "The agent didn’t write a check. Try again." };
    if (!read.command) return { state: "failed", reason: read.problem || "The agent couldn’t write a check for this." };
    return { state: "written", command: read.command, everyMinutes: clampMinutes(read.everyMinutes) };
  }

  private project(projectId: string): Project {
    const project = projects.get(this.db, projectId);
    if (!project?.rootPath) throw new Error("This project has no folder on this computer.");
    return project;
  }
}

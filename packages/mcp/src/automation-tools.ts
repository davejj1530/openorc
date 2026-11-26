import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AutomationProposal } from "@openorc/protocol";

export interface AutomationTools {
  /** Saves an automation the agent wrote, switched off, and answers with what to tell the person. */
  create(runId: string, proposal: AutomationProposal): Promise<{ id: string; message: string }>;
}

const DESCRIPTION = [
  'Write an automation for this project: when something happens, OpenOrc does the steps by itself, with nobody watching. Use it when the person asks for something to happen from now on, such as "when an issue is opened, make a task for it" or "watch the release build and fix it when it fails". It is saved switched off and the person turns it on under Automations, so tell them you wrote it and what it does.',
  '`when` is what sets it off. A pull request on the project\'s GitHub repository that is opened, merged, or whose checks failed: scope "ours" keeps to the ones OpenOrc\'s own threads opened, "any" takes every one. A task created in the project. Or a check you write, for anything else.',
  "A check is a shell command OpenOrc runs in the project folder every `everyMinutes`. Each line it prints is one thing that happened and is acted on once, so print one line for each thing and nothing when there is nothing; a line printed again later is ignored. To tell things apart by an id and describe them in words, print the id, a tab, then the words, as `gh issue list --json number,title --jq '.[] | \"\\(.number)\\t#\\(.number) \\(.title)\"'` does. What is already there when the automation is turned on is only noted; it acts on what comes after. Run the command yourself first to see that it prints what you expect, and say in `what` what it looks for in plain words.",
  "`do` is up to four steps in order: start an agent with a prompt, move the task to a board column or a status, or create a task from what happened, which the steps after it then work on. An agent started for a task works where the task's work is.",
].join("\n\n");

export function registerAutomationTools(mcp: McpServer, tools: AutomationTools, runId: string): void {
  mcp.registerTool("automation_create", { description: DESCRIPTION, inputSchema: AutomationProposal.shape }, async (proposal) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.create(runId, proposal)) }],
  }));
}

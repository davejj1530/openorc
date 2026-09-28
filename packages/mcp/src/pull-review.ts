import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface PullReviewComment {
  path: string;
  line: number;
  side: "old" | "new";
  startLine?: number;
  startSide?: "old" | "new";
  body: string;
}

/**
 * What a model reviewing a pull request can do: read the changes and write
 * draft comments and a summary. The user decides what reaches GitHub.
 */
export interface PullReviewTools {
  /** Whether the run belongs to a conversation reviewing a pull request. */
  available(runId: string): boolean;
  /** The pull request's changes, or with `since` only those after a commit from an earlier review. */
  diff(runId: string, input: { path?: string; since?: string }): Promise<string>;
  comment(runId: string, comment: PullReviewComment): Promise<string>;
  summary(runId: string, body: string): Promise<string>;
}

const side = z.enum(["old", "new"]);
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function registerPullReviewTools(mcp: McpServer, tools: PullReviewTools, runId: string): void {
  mcp.registerTool(
    "pull_request_diff",
    {
      description:
        "The pull request's changes as a unified diff, exactly what its draft comments attach to. Without a path, a large pull request returns its changed files instead; then ask for one path at a time. With since, a commit from an earlier review, it shows only what changed after it.",
      inputSchema: {
        path: z.string().min(1).optional(),
        since: z
          .string()
          .regex(/^[0-9a-f]{7,40}$/)
          .optional(),
      },
    },
    async ({ path, since }) => text(await tools.diff(runId, { ...(path === undefined ? {} : { path }), ...(since === undefined ? {} : { since }) })),
  );
  mcp.registerTool(
    "pull_request_comment",
    {
      description:
        "Add one finding to the user's draft review, on a line of the pull request's diff. side is new for an added or unchanged line (its number in the new file) and old for a removed line. For a range, start_line and start_side mark the first line, and the range must stay within one hunk. The user edits and decides what to post.",
      inputSchema: {
        path: z.string().min(1),
        line: z.number().int().positive(),
        side: side.default("new"),
        start_line: z.number().int().positive().optional(),
        start_side: side.optional(),
        body: z.string().trim().min(1).max(65_536),
      },
    },
    async ({ path, line, side: lineSide, start_line, start_side, body }) =>
      text(await tools.comment(runId, { path, line, side: lineSide, ...(start_line === undefined ? {} : { startLine: start_line, startSide: start_side ?? lineSide }), body })),
  );
  mcp.registerTool(
    "pull_request_summary",
    {
      description: "Set the draft review's overall summary: your assessment and the most important findings. Each call replaces the previous summary.",
      inputSchema: { body: z.string().trim().min(1).max(65_536) },
    },
    async ({ body }) => text(await tools.summary(runId, body)),
  );
}

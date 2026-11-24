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
 * What a model reviewing a pull request can do: read the changes and the draft,
 * and write, change and remove its comments and summary, the user's included.
 * The user decides what reaches GitHub.
 */
export interface PullReviewTools {
  /** Whether the run belongs to a conversation reviewing a pull request. */
  available(runId: string): boolean;
  /** The pull request's changes, or with `since` only the hunks that changed after a commit from an earlier review. */
  diff(runId: string, input: { path?: string; since?: string }): Promise<string>;
  /** The draft as it stands: its summary, and each comment under the id the two below take. */
  draft(runId: string): Promise<string>;
  comment(runId: string, comment: PullReviewComment): Promise<string>;
  editComment(runId: string, id: string, body: string): Promise<string>;
  deleteComment(runId: string, id: string): Promise<string>;
  summary(runId: string, body: string): Promise<string>;
}

const side = z.enum(["old", "new"]);
const body = z.string().trim().min(1).max(65_536);
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function registerPullReviewTools(mcp: McpServer, tools: PullReviewTools, runId: string): void {
  mcp.registerTool(
    "pull_request_diff",
    {
      description:
        "The pull request's changes as a unified diff, exactly what its draft comments attach to. Without a path, a large pull request returns its changed files instead; then ask for one path at a time. With since, a commit from an earlier review, it shows only the hunks that changed after it, numbered as in the full diff.",
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
    "pull_request_draft",
    {
      description:
        "The draft review as it stands: its summary and every comment, yours and the user's, each under its id, with the lines it is on and who wrote it. Read it before you change or remove a comment.",
      inputSchema: {},
    },
    async () => text(await tools.draft(runId)),
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
        body,
      },
    },
    async ({ path, line, side: lineSide, start_line, start_side, body }) =>
      text(await tools.comment(runId, { path, line, side: lineSide, ...(start_line === undefined ? {} : { startLine: start_line, startSide: start_side ?? lineSide }), body })),
  );
  mcp.registerTool(
    "pull_request_edit_comment",
    {
      description: "Replace what one comment of the draft review says, by its id from pull_request_draft. The comment stays on its lines; to move one, delete it and add it again.",
      inputSchema: { id: z.string().min(1), body },
    },
    async ({ id, body: said }) => text(await tools.editComment(runId, id, said)),
  );
  mcp.registerTool(
    "pull_request_delete_comment",
    {
      description: "Remove one comment from the draft review, by its id from pull_request_draft.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => text(await tools.deleteComment(runId, id)),
  );
  mcp.registerTool(
    "pull_request_summary",
    {
      description:
        "Set the draft review's overall summary: your assessment and the most important findings. Each call replaces your previous summary. A summary the user wrote is kept, and yours is offered beside it.",
      inputSchema: { body },
    },
    async ({ body }) => text(await tools.summary(runId, body)),
  );
}

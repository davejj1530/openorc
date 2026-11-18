import { HOSTED_REASONS, hostedRunId, type RpcParams, type ThreadSearchHit, type ThreadSummary } from "@openorc/protocol";
import { Refused, type Session } from "./session.js";
import { ROUTES } from "./wire.js";

/**
 * The palette's search of cloud threads (`threads.search`) in `spaces`: the server's hits in the app's shape, each in a
 * thread the account lists (`listed`), under the project the sidebar shows it in. A server without the search says so
 * in the app's words rather than finding nothing.
 */
export async function searchThreads(
  session: Session,
  spaces: readonly string[],
  listed: ReadonlyMap<string, ThreadSummary>,
  { query, projectId, limit = 30 }: Omit<RpcParams<"threads.search">, "spaceId">,
): Promise<ThreadSearchHit[]> {
  const asked = projectId ? 100 : limit;
  const pages = await Promise.all(
    spaces.map((space) =>
      session
        .in(space)
        .request(ROUTES.search(query, asked))
        .catch((error: unknown) => {
          if (error instanceof Refused && error.status === 404) throw new Refused(HOSTED_REASONS.search);
          throw error;
        }),
    ),
  );
  return pages
    .flatMap((page) => page.hits)
    .flatMap((hit): ThreadSearchHit[] => {
      const thread = listed.get(hit.threadId);
      if (!thread || (projectId && thread.projectId !== projectId)) return [];
      return [
        {
          threadId: hit.threadId,
          threadTitle: thread.title,
          projectId: thread.projectId,
          runId: hostedRunId(hit.threadId),
          messageId: hit.messageId,
          turn: hit.turn,
          role: hit.role,
          snippet: hit.snippet,
          ts: hit.at,
          taskId: null,
          taskTitle: null,
          member: hit.author ? { key: hit.author.id, name: hit.author.name } : null,
        },
      ];
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

/**
 * Reviewing a pull request of a project only OpenOrc Cloud has. The draft is the person's own, kept by the server
 * beside the cloud thread where a model reviews the pull request; this Mac keeps none of it. Posting stays the app's:
 * it posts the draft with the person's own GitHub, then says what it posted, and an edit made meanwhile stays.
 *
 * Every call names the project as the app does and is asked in that project's space. Each change tells the app to read
 * the draft again.
 */
import type { CorePush, PullRequestDraftComment, PullRequestReview } from "@openorc/protocol";
import { Refused, type Requests, type Session } from "./session.js";
import { PULL_REVIEW_ROUTES, type WirePullReview, type WirePullReviewComment } from "./wire-pull-reviews.js";

type Key = { projectId: string; number: number };
type Reviewer = { agent: string; model: string | null; effort: string | null };
type Comment = Pick<PullRequestDraftComment, "path" | "startLine" | "startSide" | "line" | "side" | "lineText" | "body">;

const commentOf = (wire: WirePullReviewComment): PullRequestDraftComment => ({
  ...wire,
  author: wire.author as PullRequestDraftComment["author"],
  createdAt: Date.parse(wire.createdAt),
});

export class CloudPullReviews {
  constructor(
    private readonly deps: {
      session: Session;
      /** The server's project and its space for the app's project; null for one OpenOrc Cloud doesn't have. */
      project(projectId: string): { id: string; space: string } | null;
      push(push: CorePush): void;
    },
  ) {}

  async get(key: Key): Promise<PullRequestReview | null> {
    const { on, id } = this.#at(key.projectId);
    const { review } = await on.request(PULL_REVIEW_ROUTES.read(id, key.number));
    return review && this.#reviewOf(key.projectId, review);
  }

  /** A model starts reviewing the pull request at `headSha`, the head the app read; answers the review's cloud thread. */
  async start(key: Key, headSha: string, reviewer: Reviewer): Promise<{ threadId: string }> {
    const { on, id } = this.#at(key.projectId);
    const started = await on.request(PULL_REVIEW_ROUTES.start(), { projectId: id, number: key.number, headSha, reviewer });
    this.#changed();
    return started;
  }

  async comment(key: Key & { commitId: string }, comment: Comment): Promise<PullRequestDraftComment> {
    const { on, id } = this.#at(key.projectId);
    const added = await on.request(PULL_REVIEW_ROUTES.comment(id, key.number), { commitId: key.commitId, ...comment });
    this.#changed();
    return commentOf(added);
  }

  async editComment(key: Key, commentId: string, body: string): Promise<PullRequestDraftComment> {
    const { on, id } = this.#at(key.projectId);
    const edited = await on.request(PULL_REVIEW_ROUTES.editComment(id, key.number, commentId), { body });
    this.#changed();
    return commentOf(edited);
  }

  async removeComment(key: Key, commentId: string): Promise<void> {
    const { on, id } = this.#at(key.projectId);
    await on.request(PULL_REVIEW_ROUTES.removeComment(id, key.number, commentId));
    this.#changed();
  }

  async setSummary(key: Key, commitId: string, summary: string): Promise<void> {
    const { on, id } = this.#at(key.projectId);
    await on.request(PULL_REVIEW_ROUTES.summary(id, key.number), { commitId, summary });
    this.#changed();
  }

  async discard(key: Key): Promise<void> {
    const { on, id } = this.#at(key.projectId);
    await on.request(PULL_REVIEW_ROUTES.discard(id, key.number));
    this.#changed();
  }

  /** What was posted to GitHub, as the draft stood when it was sent: what changed since stays in the draft. */
  async posted(key: Key, sent: Pick<PullRequestReview, "comments" | "summary" | "modelSummary">): Promise<void> {
    const { on, id } = this.#at(key.projectId);
    await on.request(PULL_REVIEW_ROUTES.posted(id, key.number), {
      comments: sent.comments.map(({ id: commentId, body }) => ({ id: commentId, body })),
      summary: sent.summary,
      modelSummary: sent.modelSummary,
    });
    this.#changed();
  }

  /** The draft changed on the server, by the model's tools or another of the person's apps: read it again. */
  heard(): void {
    this.#changed();
  }

  #at(projectId: string): { on: Requests; id: string } {
    const project = this.deps.project(projectId);
    if (!project) throw new Refused("This project isn't on OpenOrc Cloud.");
    return { on: this.deps.session.in(project.space), id: project.id };
  }

  #reviewOf(projectId: string, wire: WirePullReview): PullRequestReview {
    return { ...wire, projectId, comments: wire.comments.map(commentOf), updatedAt: Date.parse(wire.updatedAt) };
  }

  #changed(): void {
    this.deps.push({ type: "invalidate", keys: ["pull-reviews"] });
  }
}

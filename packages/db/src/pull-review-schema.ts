/**
 * Reviews drafted in OpenOrc for a project's GitHub pull requests, one per
 * pull request until it is posted or discarded. A review names the commit its
 * comments were written against, and the conversation where a model reviews it
 * with the commit the reviewed changes start from.
 */
export const pullRequestReviewMigration = `
CREATE TABLE pull_request_reviews (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 number INTEGER NOT NULL CHECK(number > 0),
 commit_id TEXT NOT NULL,
 summary TEXT NOT NULL DEFAULT '',
 thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
 base_commit TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id, number)
);
CREATE UNIQUE INDEX pull_request_reviews_thread ON pull_request_reviews(thread_id) WHERE thread_id IS NOT NULL;
CREATE TABLE pull_request_review_comments (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 number INTEGER NOT NULL,
 path TEXT NOT NULL,
 start_line INTEGER,
 start_side TEXT CHECK(start_side IN ('old', 'new')),
 line INTEGER NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('old', 'new')),
 line_text TEXT,
 body TEXT NOT NULL,
 author_agent TEXT,
 author_model TEXT,
 created_at INTEGER NOT NULL,
 FOREIGN KEY(project_id, number) REFERENCES pull_request_reviews(project_id, number) ON DELETE CASCADE,
 CHECK((start_line IS NULL) = (start_side IS NULL))
);
CREATE INDEX pull_request_review_comments_review ON pull_request_review_comments(project_id, number, created_at);
`;

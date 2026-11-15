/**
 * Claude Code's own note on a publish it asks about: the page it goes to, or null for a new one. An ask rule of the
 * user's own asks before the note is made.
 */
const PUBLISH_TARGET = "__artifactPublishTarget";
/** The actions of Claude Code's Artifact tool. A call that names none publishes. */
const ACTIONS: ReadonlySet<string> = new Set(["publish", "list", "read", "delete", "open", "pin", "unpin", "quickstart"]);

function webAddress(value: unknown): value is string {
  return typeof value === "string" && !/\s/.test(value) && URL.canParse(value) && new URL(value).protocol === "https:";
}

function publishAsk(value: Record<string, unknown>): string | undefined {
  const file = value["file_path"];
  if (typeof file !== "string") return undefined;
  // Once allowed, Claude Code publishes the same file to that page again without asking, so the answer covers those too.
  const later = "Claude can update the page later in this conversation without asking.";
  const page = value["url"];
  if (page) return `Publish ${file} to claude.ai, replacing the page at ${page}${value["force"] === true ? " and overwriting any newer version there" : ""}? ${later}`;
  // With no address, a file published before goes to its page again. Only Claude Code's own note says the page is new.
  return `Publish ${file} to claude.ai${value[PUBLISH_TARGET] === null ? " as a new private page" : ""}? ${later}`;
}

/**
 * What a Claude Artifact call does on claude.ai, in words: the permission prompt tool receives only the tool's name and
 * input, never Claude Code's own wording. A call with an action or an address this does not know gets no words, so the
 * card shows the request as it came instead of summing it up as something milder.
 */
export function artifactAsk(input: unknown): string | undefined {
  const value = (input ?? {}) as Record<string, unknown>;
  const action = value["action"] ?? "publish";
  const page = value["url"];
  if (typeof action !== "string" || !ACTIONS.has(action) || (page !== undefined && !webAddress(page))) return undefined;
  if (action === "publish") return publishAsk(value);
  return `Allow Artifact ${action} on claude.ai${page ? ` for ${page}` : ""}?`;
}

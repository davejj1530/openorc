import { redact, redactValue } from "@openorc/db";
import {
  isRemoteMethod,
  phoneEvents,
  REMOTE_ATTACHMENT_BYTES,
  rpcParams,
  supportsSubagents,
  type RemoteMethod,
  type RemotePush,
  type RpcParams,
  type RpcResults,
  type Thread,
} from "@openorc/protocol";
import path from "node:path";
import type { Broadcast } from "../transport.js";
import { previewReply, type PhoneShaping } from "./phone-words.js";

/*
 * What a paired phone may do and hear. A paired phone is the user, able to start autonomous work on this Mac, so
 * pairing and the encrypted session are the boundary. This is least privilege on top: host paths, secrets, remote
 * access itself and desktop-only flows stay on the Mac.
 */

export interface GuardContext {
  /** The only folder a phone's attachment paths may name. */
  attachmentsDir: string;
  /** A thread as the guards need it, read synchronously; null when there is no such thread. */
  thread(id: string): { team: boolean; parentRelation?: Thread["parentRelation"] } | null;
}

/** Null admits; a string refuses with that message. Guards see params already parsed by the method's schema. */
type Guard<M extends RemoteMethod> = (params: RpcParams<M>, context: GuardContext) => string | null;

const allow = () => null;
const STORED_IMAGE = /^[a-f0-9-]+\.(?:png|jpg|gif|webp)$/;
/** attachments.saveFile's names: a UUID, then the name the file was given. */
const STORED_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[A-Za-z0-9._-]+$/;
const MAX_ATTACHMENT_BASE64 = Math.ceil(REMOTE_ATTACHMENT_BYTES / 3) * 4;
/** What the phone's own controls change: the composer's settings, and how threads are organized (read state, pins, archive, snooze, title). */
const PHONE_THREAD_PATCH = new Set(["seen", "agent", "model", "effort", "fastMode", "mode", "permissionMode", "pinned", "archived", "snoozedUntil", "title"]);
/** A snooze from the phone wakes within this long. */
const SNOOZE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const TITLE_MAX = 200;
/** Control characters, line and paragraph breaks, and bidi overrides and isolates: a title goes into briefs, logs and notifications. */
const TITLE_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;
/** A commit message keeps tabs and line feeds, and nothing else that moves a terminal or reorders text. */
const MESSAGE_FORBIDDEN = /(?![\t\n])[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const COMMIT_MESSAGE_MAX = 10_000;
/** GitHub's own limits for a pull request's title and body. */
const PR_TITLE_MAX = 256;
const PR_BODY_MAX = 65_536;

const storedIn = (paths: readonly string[] | undefined, { attachmentsDir }: GuardContext, names: (name: string) => boolean): boolean =>
  paths?.every((file) => path.resolve(file) === file && path.dirname(file) === attachmentsDir && names(path.basename(file))) ?? true;

/** Each path must be an image this profile stored with attachments.save. */
function storedImages(paths: readonly string[] | undefined, context: GuardContext): string | null {
  return storedIn(paths, context, (name) => STORED_IMAGE.test(name)) ? null : "Only images attached from your phone can be sent from it.";
}

/** Each path must be an image or a file this profile stored, with attachments.save or attachments.saveFile. */
function storedFiles(paths: readonly string[] | undefined, context: GuardContext): string | null {
  return storedIn(paths, context, (name) => STORED_IMAGE.test(name) || STORED_FILE.test(name)) ? null : "This file did not reach the cloud. Attach it again.";
}

function phoneTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  // Characters, not UTF-16 units: an emoji is one.
  return title.trim() && [...title].length <= TITLE_MAX && !TITLE_FORBIDDEN.test(title) ? null : `A title must be one line of up to ${TITLE_MAX} characters.`;
}

function phoneSnooze(until: number | null | undefined): string | null {
  if (until === undefined || until === null) return null;
  const now = Date.now();
  return until > now && until <= now + SNOOZE_HORIZON_MS ? null : "Choose a time within the next year.";
}

/** Reject mutations of retired conversations from older clients. */
function teamWork(threadId: string, { thread }: GuardContext): string | null {
  return thread(threadId)?.team ? "This item is no longer available." : null;
}

function commitMessage(message: string): string | null {
  return [...message].length <= COMMIT_MESSAGE_MAX && !MESSAGE_FORBIDDEN.test(message)
    ? null
    : `A commit message must be plain text of up to ${COMMIT_MESSAGE_MAX.toLocaleString("en-US")} characters.`;
}

function prTitle(title: string): string | null {
  return title.trim() && [...title].length <= PR_TITLE_MAX && !TITLE_FORBIDDEN.test(title) ? null : `A pull request title must be one line of up to ${PR_TITLE_MAX} characters.`;
}

function prBody(body: string): string | null {
  return [...body].length <= PR_BODY_MAX ? null : `A pull request body must be up to ${PR_BODY_MAX.toLocaleString("en-US")} characters.`;
}

function threadUpdate({ patch }: RpcParams<"threads.update">): string | null {
  if (!Object.keys(patch).every((key) => PHONE_THREAD_PATCH.has(key))) return "Make this change on your Mac.";
  return phoneTitle(patch.title) ?? phoneSnooze(patch.snoozedUntil);
}

/** Typed over REMOTE_METHODS: a method listed there without a guard here, or guarded but not listed, fails the build. */
export const remoteGuards: { [M in RemoteMethod]: Guard<M> } = {
  "projects.list": allow,
  "projects.get": allow,
  // Takes a project id and answers none, no_commits or ready: nothing of the folder's path.
  "projects.git": allow,
  "threads.list": allow,
  "threads.get": allow,
  "threads.messages": allow,
  "threads.lastMessage": allow,
  "runs.listForThread": allow,
  "events.page": allow,
  "events.toolOutput": allow,
  "inbox.list": allow,
  "agents.models": allow,
  "agents.availability": allow,
  // The cached list only: a refresh asks every account's CLI again, which is the Mac's Settings' to do.
  "claude.accounts.list": ({ refresh }) => (refresh ? "This is not available from a phone." : null),
  // Takes nothing and answers the shares and plans alone, shaped by the core: no email, token, path or CLI text.
  "providers.limits": allow,
  "app.settings.get": allow,
  // Whether the Mac offers cloud threads and where they would run; nothing about its accounts or tokens.
  "cloud.offer": allow,
  // Moves the conversation's work to a sandbox of its own, as the Mac's thread menu does, after the phone's confirm.
  "cloud.move": allow,
  // The files a move from the checkout would take with it, for that confirm.
  "threads.movePreview": allow,
  "cloud.bringToMac": allow,
  "cloud.keep": allow,
  "threads.start": (params, context) =>
    params.workingDirectory !== undefined ? "Choose a folder for this conversation on your Mac." : (phoneTitle(params.title) ?? storedImages(params.attachments, context)),
  "threads.update": threadUpdate,
  // The core checks conversation ownership, active turns and account availability, as on the Mac.
  "threads.switchClaudeAccount": allow,
  "runs.start": (params, context) => storedImages(params.attachments, context),
  "runs.send": (params, context) => storedImages(params.attachments, context),
  "runs.interrupt": allow,
  "subagents.stop": allow,
  "threads.queue": (params, context) => storedImages(params.attachments, context),
  "threads.unqueue": allow,
  "threads.sendQueued": allow,
  "approvals.resolve": allow,
  "attachments.save": (params) => (params.dataBase64.length > MAX_ATTACHMENT_BASE64 ? `Images sent from a phone must be ${REMOTE_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller.` : null),
  // Repository-relative paths and counts.
  "review.threadChanges": allow,
  // The schema's FolderPath and the core's own check that the file is among the changes hold the path.
  "review.threadFileDiff": allow,
  "git.threadLog": allow,
  "git.threadPushState": allow,
  "review.threadPrTemplate": allow,
  // Branch names; one gh call.
  "pulls.branches": allow,
  "system.gh": allow,
  // The core's mutation fence and the user's own hooks and gh login, exactly as for a window.
  "review.commitThread": (params, context) => teamWork(params.threadId, context) ?? commitMessage(params.message),
  "review.pushThread": (params, context) => teamWork(params.threadId, context),
  "review.createThreadPr": (params, context) => teamWork(params.threadId, context) ?? prTitle(params.title) ?? prBody(params.body),
  // One page's state; the handler answers closed for a missing or retired thread.
  "preview.state": allow,
};

/** What a reply's shaping needs besides the result: how an error or a reason reads on a phone, and the Mac's folders. */
export type ReplyContext = PhoneShaping & { capabilities?: readonly string[] };
type Reply<M extends RemoteMethod> = (result: RpcResults[M], context: ReplyContext) => RpcResults[M];
const same = <T>(result: T): T => result;

/**
 * What a phone hears of each result. Typed over REMOTE_METHODS like the guards, so a method added later must say how
 * its result is shaped. Guards see only params: file text, commit subjects and a repository's template can hold a
 * token the ledger would have redacted.
 */
export const remoteReplies: { [M in RemoteMethod]: Reply<M> } = {
  "projects.list": same,
  "projects.get": same,
  "projects.git": same,
  "threads.list": (rows, { capabilities }) => (supportsSubagents(capabilities) ? rows : rows.filter((row) => row.parentRelation !== "subagent")),
  "threads.get": (row, { capabilities }) => (!supportsSubagents(capabilities) && row?.parentRelation === "subagent" ? null : row),
  "threads.messages": same,
  "threads.lastMessage": same,
  "runs.listForThread": same,
  "events.page": (page, { capabilities }) => ({ ...page, events: phoneEvents(page.events, capabilities) }),
  "events.toolOutput": same,
  "inbox.list": (inbox, { capabilities }) => ({
    ...inbox,
    items: supportsSubagents(capabilities) ? inbox.items : inbox.items.filter((item) => item.kind !== "thread" || item.thread.parentRelation !== "subagent"),
  }),
  "agents.models": same,
  "agents.availability": same,
  // A sign-in's email and organization, and the CLI's own words, stay on the Mac.
  "claude.accounts.list": ({ accounts, defaultId }) => ({ defaultId, accounts: accounts.map((account) => ({ ...account, email: null, organization: null, message: null })) }),
  "providers.limits": same,
  "app.settings.get": same,
  "cloud.offer": same,
  "cloud.move": same,
  "threads.movePreview": same,
  "cloud.bringToMac": same,
  "cloud.keep": same,
  "threads.start": same,
  "threads.update": same,
  "threads.switchClaudeAccount": same,
  "runs.start": same,
  "runs.send": same,
  "runs.interrupt": same,
  "subagents.stop": same,
  "threads.queue": same,
  "threads.unqueue": same,
  "threads.sendQueued": same,
  "approvals.resolve": same,
  "attachments.save": same,
  "review.threadChanges": same,
  "review.threadFileDiff": (diff) => ({ ...diff, patch: redact(diff.patch).text }),
  "git.threadLog": (log) => redactValue(log).value,
  // Why Push is blocked can be Git's own error, which names the Mac's folders.
  "git.threadPushState": (state, { words }) => (state.blocked ? { ...state, blocked: words(state.blocked) } : state),
  "review.threadPrTemplate": (template) => redactValue(template).value,
  "pulls.branches": same,
  "system.gh": same,
  "review.commitThread": same,
  "review.pushThread": same,
  "review.createThreadPr": same,
  "preview.state": (state, context) => previewReply(state, context),
};

/** One result shaped for a phone by its method's entry in remoteReplies. */
export function remoteReply<M extends RemoteMethod>(method: M, result: RpcResults[M], context: ReplyContext): RpcResults[M] {
  return (remoteReplies[method] as Reply<M>)(result, context);
}

/** Exclude children before pagination as well as shaping the result, so legacy pages still fill with conversations. */
export function remoteParams(method: RemoteMethod, params: unknown, capabilities: readonly string[]): unknown {
  if (method !== "threads.list" || supportsSubagents(capabilities)) return params;
  const parsed = rpcParams[method].safeParse(params ?? {});
  return parsed.success ? { ...parsed.data, excludeSubagents: true, includeChildren: false } : params;
}

export type RemoteAdmission = { ok: true } | { ok: false; message: string };

/**
 * The brain's own Mac asks under a phone's guards except here, where its windows do more with the threads they forward:
 * they keep a thread's draft, done mark and pull request, and attach any file the Mac stored on the brain first.
 */
const ownerGuards: Partial<{ [M in RemoteMethod]: Guard<M> }> = {
  "threads.update": allow,
  "threads.start": (params, context) => remoteGuards["threads.start"]({ ...params, attachments: undefined }, context) ?? storedFiles(params.attachments, context),
  "runs.start": (params, context) => storedFiles(params.attachments, context),
  "runs.send": (params, context) => storedFiles(params.attachments, context),
  "threads.queue": (params, context) => storedFiles(params.attachments, context),
};

/** Admits one phone request, or one from the brain's own Mac, or says why not. Params a method's schema rejects pass through, so `handle` words the error. */
export function admitRemoteRequest(method: string, params: unknown, context: GuardContext, from: "phone" | "owner" = "phone"): RemoteAdmission {
  if (!isRemoteMethod(method)) return { ok: false, message: "This is not available from a phone." };
  const parsed = rpcParams[method].safeParse(params ?? {});
  if (!parsed.success) return { ok: true };
  const guard = (from === "owner" ? ownerGuards[method] : undefined) ?? remoteGuards[method];
  const refusal = (guard as Guard<RemoteMethod>)(parsed.data as RpcParams<RemoteMethod>, context);
  return refusal ? { ok: false, message: refusal } : { ok: true };
}

/** Every push the core makes, and what a phone hears of it. A new push type does not compile until it is placed. */
const pushes: { [T in Broadcast["type"]]: (push: Extract<Broadcast, { type: T }>) => RemotePush | null } = {
  frame: (push) => push,
  invalidate: (push) => push,
  // Titles quote commands an agent wants to run.
  notify: (push) => redactValue(push).value,
  // The core's process id and MCP port are the Mac's business.
  ready: () => ({ type: "ready" }),
  // A phone only ever meets a core that is up. Logs carry paths and provider output; benchmarks are QA traffic.
  startup: () => null,
  log: () => null,
  "bench.done": () => null,
  // The phone has no Device panel.
  "device.panel": () => null,
  // Only for the Mac's windows: phones hear the brain themselves.
  gap: () => null,
};

export function remotePush(push: Broadcast): RemotePush | null {
  return (pushes[push.type] as (push: Broadcast) => RemotePush | null)(push);
}

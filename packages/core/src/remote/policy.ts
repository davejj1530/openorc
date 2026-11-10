import { orclings, redact, redactValue, retiredTeams, tasks, threads, type Db } from "@openorc/db";
import {
  isRemoteMethod,
  phoneEvents,
  REMOTE_ATTACHMENT_BYTES,
  rpcParams,
  supportsSubagents,
  type OrclingDraft,
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
  /** A task's description as stored, read synchronously; null when there is no such task. */
  task(id: string): { spec: string | null } | null;
  /** An Orcling's current instructions as stored, read synchronously; null when there is no such Orcling. */
  orcling(id: string): { instructions: string | null } | null;
}

/** The guards' view of the ledger: a phone's session and an Orcling acting for the person read the same rows. */
export function guardContext(db: Db, dataDir: string): GuardContext {
  return {
    attachmentsDir: path.join(dataDir, "attachments"),
    thread: (id) => {
      const thread = threads.get(db, id);
      return thread ? { team: retiredTeams.isHidden(db, id), parentRelation: thread.parentRelation } : null;
    },
    task: (id) => {
      const task = tasks.get(db, id);
      return task ? { spec: task.spec } : null;
    },
    orcling: (id) => (orclings.get(db, id) ? { instructions: orclings.instructions(db, id)[0]?.body ?? null } : null),
  };
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
/** What the phone's task screen changes: the title, status, priority, labels and description, never the workspace. */
const PHONE_TASK_PATCH = new Set(["title", "spec", "status", "priority", "labels"]);
const TASK_LABELS_MAX = 20;
const TASK_LABEL_MAX = 50;
const TASK_SPEC_MAX = 100_000;
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

function taskLabels(labels: readonly string[] | undefined): string | null {
  if (labels === undefined) return null;
  const fits = labels.length <= TASK_LABELS_MAX && labels.every((label) => label.trim() && [...label].length <= TASK_LABEL_MAX && !TITLE_FORBIDDEN.test(label));
  return fits ? null : `A task takes up to ${TASK_LABELS_MAX} labels of up to ${TASK_LABEL_MAX} characters each.`;
}

/**
 * A phone reads a description with its secrets redacted, so a description it saves over one that holds a secret would
 * lose the secret: that description is edited on the Mac.
 */
function plainSpec(spec: string | null | undefined): string | null {
  if (spec === undefined || spec === null) return null;
  return [...spec].length > TASK_SPEC_MAX || MESSAGE_FORBIDDEN.test(spec) ? `A description must be plain text of up to ${TASK_SPEC_MAX.toLocaleString("en-US")} characters.` : null;
}

function taskSpec(id: string, spec: string | null | undefined, { task }: GuardContext): string | null {
  if (spec === undefined) return null;
  if (plainSpec(spec)) return plainSpec(spec);
  const stored = task(id)?.spec;
  return stored && redact(stored).redacted ? "This description holds a secret, so edit it on your Mac." : null;
}

/** What the phone's New task screen sends: a project, title, description, priority and labels, and whether it works in a worktree. */
const PHONE_TASK_CREATE = new Set(["projectId", "title", "spec", "priority", "labels", "useWorktree"]);

/** A task a phone saves: on its own in a project, never under a thread, from a branch or in a folder the phone names. */
function taskCreate(params: RpcParams<"tasks.create">): string | null {
  if (!Object.keys(params).every((key) => PHONE_TASK_CREATE.has(key))) return "Make this change on your Mac.";
  return phoneTitle(params.title) ?? taskLabels(params.labels) ?? plainSpec(params.spec);
}

function taskUpdate({ id, patch }: RpcParams<"tasks.update">, context: GuardContext): string | null {
  if (!Object.keys(patch).every((key) => PHONE_TASK_PATCH.has(key))) return "Make this change on your Mac.";
  return phoneTitle(patch.title) ?? taskLabels(patch.labels) ?? taskSpec(id, patch.spec, context);
}

/** A task as a phone reads it: a worktree's path names the Mac's folders, and a description may hold a token. */
const phoneTask = <T extends RpcResults["tasks.update"] | null>(task: T): T => (task ? { ...task, worktreePath: null, spec: task.spec === null ? null : redact(task.spec).text } : task);

/** An Orcling's name titles its conversation and its notifications. */
const orclingName = ({ draft }: { draft: OrclingDraft }): string | null => (TITLE_FORBIDDEN.test(draft.name) ? "A name must be one line." : null);

/** An Orcling's instructions go into every turn it takes, so they are plain text, and ones that hold a secret the phone reads redacted are rewritten on the Mac. */
function orclingInstructions({ id, body }: RpcParams<"orclings.instructions.save">, { orcling }: GuardContext): string | null {
  if (MESSAGE_FORBIDDEN.test(body)) return "Instructions must be plain text.";
  const stored = orcling(id)?.instructions;
  return stored && redact(stored).redacted ? "These instructions hold a secret, so edit them on your Mac." : null;
}

const NOT_FROM_PHONE = "This is not available from a phone.";

/** Typed over REMOTE_METHODS: a method listed there without a guard here, or guarded but not listed, fails the build. */
export const remoteGuards: { [M in RemoteMethod]: Guard<M> } = {
  "projects.list": allow,
  "projects.get": allow,
  // Takes a project id and answers none, no_commits or ready: nothing of the folder's path.
  "projects.git": allow,
  "threads.list": allow,
  // A number: how many threads Resolved holds in the projects named.
  "threads.resolvedCount": allow,
  "threads.get": allow,
  "threads.messages": allow,
  "threads.lastMessage": allow,
  "runs.listForThread": allow,
  "events.page": allow,
  "events.toolOutput": allow,
  "inbox.list": allow,
  "agents.models": allow,
  "agents.availability": allow,
  // A conversation's folder, or a project's; only the Mac chooses a folder by its path.
  "skills.list": ({ scope }) => (scope.kind === "project" && scope.workingDirectory !== undefined ? "Choose a folder for this conversation on your Mac." : null),
  // The cached list only: a refresh asks every account's CLI again, which is the Mac's Settings' to do.
  "claude.accounts.list": ({ refresh }) => (refresh ? NOT_FROM_PHONE : null),
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
  // The brain's sandboxes are for its own Mac's Settings, which the owner guards let through.
  "cloud.sandboxes": () => NOT_FROM_PHONE,
  "cloud.sandboxes.remove": () => NOT_FROM_PHONE,
  "threads.start": (params, context) => {
    if (params.workingDirectory !== undefined) return "Choose a folder for this conversation on your Mac.";
    // Only the brain's own Mac names a thread's id, for the thread its windows show before the brain has it.
    if (params.id !== undefined) return NOT_FROM_PHONE;
    return phoneTitle(params.title) ?? storedImages(params.attachments, context);
  },
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
  // Commit ids and a branch name; reads only.
  "git.commitRange": allow,
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
  // Reads one task by id, saves a new one and edits what its screen shows; starting, moving or deleting one stays on the Mac.
  "tasks.get": allow,
  "tasks.create": taskCreate,
  "tasks.update": taskUpdate,
  // Faces, names and their own conversations' state; the reply leaves the rest of each Orcling on the Mac.
  "orclings.chats": allow,
  "orclings.profile": allow,
  // What its designer on the Mac makes and changes, which the schema bounds.
  "orclings.create": orclingName,
  "orclings.update": orclingName,
  "orclings.delete": allow,
  // When it checks in: the schema bounds the list, and nothing there reaches its model, account or instructions.
  "orclings.wakes.save": allow,
  "orclings.instructions.save": orclingInstructions,
  // The core takes tapbacks only in an Orcling's own conversation, on a message there.
  "orclings.reactions": allow,
  "orclings.react": allow,
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
  "threads.resolvedCount": same,
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
  // Where each skill's file lives on the Mac stays there, and its image, which can be large; a description is the skill
  // author's text and may hold a token. A phone offers what the agent uses, so a skill turned off is left out, and it
  // changes no skill, so whether one could be changed stays too.
  "skills.list": (skills) =>
    skills
      .filter((skill) => skill.enabled !== false)
      .map(({ icon: _icon, enabled: _enabled, editable: _editable, ...skill }) => ({
        ...skill,
        path: "",
        description: redact(skill.description).text,
        ...(skill.shortDescription === undefined ? {} : { shortDescription: redact(skill.shortDescription).text }),
      })),
  // A sign-in's email and organization, and the CLI's own words, stay on the Mac.
  "claude.accounts.list": ({ accounts, defaultId }) => ({ defaultId, accounts: accounts.map((account) => ({ ...account, email: null, organization: null, message: null })) }),
  "providers.limits": same,
  "app.settings.get": same,
  "cloud.offer": same,
  "cloud.move": same,
  "threads.movePreview": same,
  "cloud.bringToMac": same,
  "cloud.keep": same,
  "cloud.sandboxes": same,
  "cloud.sandboxes.remove": same,
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
  "git.commitRange": (range) => redactValue(range).value,
  // Why Push is blocked can be Git's own error, which names the Mac's folders.
  "git.threadPushState": (state, { words }) => (state.blocked ? { ...state, blocked: words(state.blocked) } : state),
  "review.threadPrTemplate": (template) => redactValue(template).value,
  "pulls.branches": same,
  "system.gh": same,
  "review.commitThread": same,
  "review.pushThread": same,
  "review.createThreadPr": same,
  "preview.state": (state, context) => previewReply(state, context),
  "tasks.get": phoneTask,
  "tasks.create": phoneTask,
  "tasks.update": phoneTask,
  "orclings.chats": same,
  // Instructions and memories are text that may hold a token.
  "orclings.profile": (profile) => ({
    ...profile,
    instructions: profile.instructions === null ? null : redact(profile.instructions).text,
    memories: profile.memories.map((memory) => ({ ...memory, title: redact(memory.title).text, body: redact(memory.body).text })),
  }),
  "orclings.create": same,
  "orclings.update": same,
  "orclings.delete": same,
  "orclings.wakes.save": same,
  "orclings.instructions.save": (version) => ({ ...version, body: redact(version.body).text, note: version.note === null ? null : redact(version.note).text }),
  "orclings.reactions": same,
  "orclings.react": same,
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
 * they keep a thread's draft, done mark and pull request, and attach any file the Mac stored on the brain first; its
 * Settings list and delete the brain's sandboxes.
 */
const ownerGuards: Partial<{ [M in RemoteMethod]: Guard<M> }> = {
  "threads.update": allow,
  // Its Settings list the sandboxes the brain made for its threads, and delete one there.
  "cloud.sandboxes": allow,
  "cloud.sandboxes.remove": allow,
  "threads.start": ({ id: _id, ...params }, context) => remoteGuards["threads.start"]({ ...params, attachments: undefined }, context) ?? storedFiles(params.attachments, context),
  "runs.start": (params, context) => storedFiles(params.attachments, context),
  "runs.send": (params, context) => storedFiles(params.attachments, context),
  "threads.queue": (params, context) => storedFiles(params.attachments, context),
};

/** Admits one phone request, or one from the brain's own Mac, or says why not. Params a method's schema rejects pass through, so `handle` words the error. */
export function admitRemoteRequest(method: string, params: unknown, context: GuardContext, from: "phone" | "owner" = "phone"): RemoteAdmission {
  if (!isRemoteMethod(method)) return { ok: false, message: NOT_FROM_PHONE };
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

import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { orclingGroups, orclingMessages, orclings, threads, type Db } from "@openorc/db";
import { orclingHandle, WORKSPACE_ID, type Orcling, type OrclingGroup, type OrclingMessageOrigin, type Run, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { RunService } from "./runs.js";
import type { ThreadService } from "./threads.js";
import { executionProject } from "./workspace-home.js";

/** Direct messages bounce between two Orclings this many times with nobody writing before they must wait for the person. */
export const ORCLING_MESSAGE_CHAIN = 6;
/** A group's Orclings take this many turns in a row with nobody writing before the group waits for the person. */
export const GROUP_TURNS = 6;

/** What a group turn is told when someone else's words woke it: the conversation itself reaches it as a catch-up. */
const GROUP_NUDGE = "(OpenOrc: your turn in the group chat. Answer if you were named or have something to add; otherwise end your turn without writing anything.)";

interface Turn {
  orclingId: string;
  text: string;
  role: "user" | "system";
  record: boolean;
  unprompted: boolean;
  messageId?: string;
  attachments?: string[];
}

interface Dependencies {
  db: Db;
  dataDir: string;
  runs: () => Pick<RunService, "start" | "send" | "liveRunForThread" | "threadActivity" | "agentChain" | "noteAgentMessage">;
  threads: () => Pick<ThreadService, "send">;
  invalidate: (keys: string[]) => void;
  log: Logger;
}

const list = (names: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Orclings a text names, by name as a word or as an @mention, in the order they appear. */
export function namedIn(text: string, candidates: readonly Pick<Orcling, "id" | "name">[]): string[] {
  return candidates
    .map((orcling) => ({ id: orcling.id, at: text.search(new RegExp(`(^|[^\\p{L}\\p{N}])@?${escape(orcling.name)}(?![\\p{L}\\p{N}])`, "iu")) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.id);
}

/**
 * Orclings talking to each other, in the open. A direct message lands in the other Orcling's own chat as that Orcling
 * sees it from the sender, and is answered the same way. A group chat is one Workspace conversation shared by the
 * person and several Orclings: the Orclings a message names answer it in turn, or every one of them when the person
 * names none, and each hears what the others said. Both stop for the person after a short run of Orcling messages.
 */
export class OrclingTalk {
  private readonly groups = new Map<string, { queue: Turn[]; starting: boolean; orclingTurns: number }>();
  /** What an Orcling is told about the next message in its own chat when another Orcling sent it. */
  private readonly notes = new Map<string, string>();

  constructor(private readonly deps: Dependencies) {}

  private orcling(id: string): Orcling {
    const orcling = orclings.get(this.deps.db, id);
    if (!orcling) throw new Error("This Orcling no longer exists.");
    return orcling;
  }

  /** Another Orcling by name, as an Orcling would call it. */
  byName(name: string, except: string): Orcling {
    const handle = orclingHandle(name.replace(/^@/, ""));
    const found = orclings.list(this.deps.db).find((orcling) => orclingHandle(orcling.name) === handle);
    if (!found) throw new Error(`There is no Orcling named ${name}. orcling_orclings lists them.`);
    if (found.id === except) throw new Error("That is you.");
    return found;
  }

  origins(threadId: string): OrclingMessageOrigin[] {
    return orclingMessages.list(this.deps.db, threadId);
  }

  /** Taken once, by the next message the conversation's agent reads. */
  takeNote(threadId: string): string {
    const note = this.notes.get(threadId) ?? "";
    this.notes.delete(threadId);
    return note;
  }

  /** The other Orclings and the groups this one is in, for its orcling_orclings tool. */
  directory(orclingId: string) {
    const { db } = this.deps;
    const name = (id: string) => orclings.get(db, id)?.name ?? "a deleted Orcling";
    return {
      orclings: orclings
        .list(db)
        .filter((other) => other.id !== orclingId)
        .map((other) => ({ name: other.name, busy: this.deps.runs().threadActivity(other.threadId) !== "idle" })),
      groups: orclingGroups.of(db, orclingId).map((group) => ({ title: group.title, threadId: group.threadId, members: group.memberIds.map(name) })),
    };
  }

  /**
   * A direct message from one Orcling into another's own chat. It shows there as the sender's, its turn is quiet
   * unless the receiver writes to the person, and the receiver is told who wrote and how to answer.
   */
  async direct(fromId: string, fromThreadId: string | null, toName: string, text: string): Promise<{ to: Orcling; messageId: string }> {
    const from = this.orcling(fromId);
    const to = this.byName(toName, fromId);
    const runs = this.deps.runs();
    const hops = (fromThreadId ? runs.agentChain(fromThreadId) : 0) + 1;
    if (hops > ORCLING_MESSAGE_CHAIN) throw new Error(`You and other Orclings have traded ${ORCLING_MESSAGE_CHAIN} messages with nobody writing in between. Wait until the person writes.`);
    const messageId = `orcling-${randomUUID()}`;
    orclingMessages.record(this.deps.db, { messageId, threadId: to.threadId, fromOrclingId: from.id, toOrclingId: to.id });
    this.notes.set(
      to.threadId,
      `(OpenOrc: the next message is from ${from.name}, another of the person's Orclings, not from the person. Answer ${from.name} with orcling_message; what you write here goes to the person. If it needs no answer, end your turn without writing anything.)`,
    );
    try {
      await this.deps.threads().send(to.threadId, text, null, { unprompted: true, record: true, messageId });
    } finally {
      this.notes.delete(to.threadId);
    }
    runs.noteAgentMessage(to.threadId, hops);
    this.deps.invalidate([`origins:${to.threadId}`]);
    return { to, messageId };
  }

  groupsList(): OrclingGroup[] {
    return orclingGroups.list(this.deps.db);
  }

  /** A group chat in the Workspace, in a folder of its own, named after its Orclings unless it is given a title. */
  async createGroup(memberIds: readonly string[], title: string | undefined, createdBy: string | null): Promise<OrclingGroup> {
    const { db } = this.deps;
    const members = [...new Set(memberIds)].map((id) => this.orcling(id));
    if (members.length < 2) throw new Error("A group needs at least two Orclings.");
    const lead = members[0]!;
    const thread = threads.insert(db, {
      projectId: WORKSPACE_ID,
      title: title ?? list(members.map((member) => member.name)),
      agent: lead.settings.agent,
      model: lead.settings.model,
      effort: lead.settings.effort,
      fastMode: lead.settings.fastMode,
      claudeAccountId: lead.claudeAccountId,
      // The group's own limit, shown and changed in its composer; each Orcling also stays within its own permission.
      mode: "act",
      permissionMode: "review",
    });
    const folder = path.join(this.deps.dataDir, "orclings", "groups", thread.id);
    await mkdir(folder, { recursive: true });
    threads.update(db, thread.id, { workingDirectory: await realpath(folder) });
    orclingGroups.create(
      db,
      thread.id,
      members.map((member) => member.id),
      createdBy,
    );
    this.deps.invalidate(["orclings", "orcling-groups", "threads"]);
    return orclingGroups.get(db, thread.id)!;
  }

  deleteGroup(threadId: string): void {
    if (!orclingGroups.get(this.deps.db, threadId)) throw new Error("This group chat no longer exists.");
    this.groups.delete(threadId);
    threads.delete(this.deps.db, threadId);
    this.deps.invalidate(["orcling-groups", "threads", `thread:${threadId}`]);
  }

  /** An Orcling opens a group with the Orclings it names and its first words, which go to each of them in turn. */
  async startGroup(fromId: string, names: readonly string[], title: string | undefined, text: string): Promise<OrclingGroup> {
    const others = names.map((name) => this.byName(name, fromId));
    const group = await this.createGroup([fromId, ...others.map((other) => other.id)], title, fromId);
    const messageId = `orcling-${randomUUID()}`;
    orclingMessages.record(this.deps.db, { messageId, threadId: group.threadId, fromOrclingId: fromId, toOrclingId: null });
    this.deps.invalidate([`origins:${group.threadId}`]);
    const [first, ...rest] = others;
    void this.enqueue(group.threadId, [{ orclingId: first!.id, text, role: "system", record: true, unprompted: true, messageId }, ...rest.map((other) => this.nudge(other.id))], false);
    return group;
  }

  /**
   * The person's message to a group. With a turn under way it joins that turn, which hears it at once; the Orclings it
   * names, or every one when it names none, answer after.
   */
  async sendToGroup(threadId: string, text: string, options: { messageId?: string; attachments?: string[] }): Promise<void> {
    const group = orclingGroups.get(this.deps.db, threadId);
    if (!group) throw new Error("This group chat no longer exists.");
    const state = this.state(threadId);
    state.orclingTurns = 0;
    const named = namedIn(
      text,
      group.memberIds.map((id) => this.orcling(id)),
    );
    const speakers = named.length ? named : group.memberIds;
    const runs = this.deps.runs();
    const live = runs.liveRunForThread(threadId);
    if (live && runs.threadActivity(threadId) !== "idle") {
      await runs.send(live.id, text, { role: "user", ...options });
      await this.enqueue(
        threadId,
        speakers.filter((id) => id !== live.orclingId).map((id) => this.nudge(id)),
        true,
      );
      return;
    }
    const [first, ...rest] = speakers;
    const turns: Turn[] = [{ orclingId: first!, text, role: "user", record: true, unprompted: false, ...options }, ...rest.map((id) => this.nudge(id))];
    await this.enqueue(threadId, turns, true);
  }

  /** After any turn: in a group, the Orclings the reply named take their turns, until the group waits for the person. */
  turnEnded(thread: Thread, run: Run, reply: string | null): void {
    const group = orclingGroups.get(this.deps.db, thread.id);
    if (!group) return;
    const state = this.state(thread.id);
    if (run.orclingId && reply?.trim()) {
      state.orclingTurns += 1;
      const others = group.memberIds.filter((id) => id !== run.orclingId).map((id) => this.orcling(id));
      const named = namedIn(reply, others);
      if (state.orclingTurns < GROUP_TURNS)
        return void this.enqueue(
          thread.id,
          named.map((id) => this.nudge(id)),
          false,
        );
    }
    void this.next(thread.id);
  }

  private nudge(orclingId: string): Turn {
    return { orclingId, text: GROUP_NUDGE, role: "system", record: false, unprompted: true };
  }

  private state(threadId: string) {
    let state = this.groups.get(threadId);
    if (!state) {
      state = { queue: [], starting: false, orclingTurns: 0 };
      this.groups.set(threadId, state);
    }
    return state;
  }

  /**
   * Adds turns and starts the next when the group is free. The person's go first and stand in for any nudge already
   * waiting for the same Orcling; an Orcling's go last, once each.
   */
  private enqueue(threadId: string, turns: Turn[], person: boolean): Promise<void> {
    const state = this.state(threadId);
    if (person) {
      const coming = new Set(turns.map((turn) => turn.orclingId));
      state.queue = [...turns, ...state.queue.filter((queued) => !coming.has(queued.orclingId))];
    } else {
      const waiting = new Set(state.queue.map((queued) => queued.orclingId));
      state.queue.push(...turns.filter((turn) => !waiting.has(turn.orclingId)));
    }
    return this.next(threadId);
  }

  private async next(threadId: string): Promise<void> {
    const state = this.state(threadId);
    if (state.starting || this.deps.runs().threadActivity(threadId) !== "idle") return;
    const turn = state.queue.shift();
    if (!turn) return;
    state.starting = true;
    try {
      await this.speak(threadId, turn);
    } catch (error) {
      this.deps.log.warn(`group ${threadId}: ${this.orcling(turn.orclingId).name} could not take its turn: ${error instanceof Error ? error.message : String(error)}`);
      state.starting = false;
      return this.next(threadId);
    }
    state.starting = false;
  }

  /** One Orcling's turn in a group, on its own model and session, as it would answer anywhere it is asked. */
  private async speak(threadId: string, turn: Turn): Promise<void> {
    const { db } = this.deps;
    const orcling = this.orcling(turn.orclingId);
    const thread = threads.get(db, threadId);
    if (!thread) throw new Error("This group chat no longer exists.");
    // Always a launch as this Orcling: a warm process would be restarted as the conversation's own agent, and a group
    // has none. The launch closes whoever spoke last, resumes this Orcling's own session here and tells it what it missed.
    const { agent, model, effort, fastMode } = orcling.settings;
    await this.deps.runs().start({
      scope: { task: null, thread },
      project: executionProject(db, thread),
      agent,
      model,
      effort: effort ?? undefined,
      fastMode,
      attachments: turn.attachments,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt: turn.text,
      promptRole: turn.role,
      recordPrompt: turn.record,
      unprompted: turn.unprompted,
      ...(turn.messageId ? { promptMessageId: turn.messageId } : {}),
      resume: true,
      orclingId: orcling.id,
    });
  }
}

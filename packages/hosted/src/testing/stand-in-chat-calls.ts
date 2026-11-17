import { createHash, randomUUID } from "node:crypto";
import { actorPerson, type OrclingLook, type TeamChatPerson, type TeamMessage, type TeamOrclingCall } from "@openorc/protocol";
import { userOf } from "./stand-in-spaces.js";
import type { StandInChatRecord } from "./stand-in-chat.js";

type Reply = { status: number; body: unknown };
type Call = {
  record: StandInChatRecord;
  messageId: string;
  ownerWho: string;
  owner: TeamChatPerson;
  localOrclingId: string;
  name: string;
  look: OrclingLook;
  state: "pending" | "running" | "answered" | "failed";
  digest: string;
  attemptId: string | null;
  leaseUntil: number | null;
  reason: string | null;
  answerId: string | null;
};
const digestOf = (secret: string) => createHash("sha256").update(secret).digest("base64url");
const absent = (): Reply => ({ status: 404, body: { message: "That Orcling call isn't here." } });
const refused = (message: string): Reply => ({ status: 409, body: { message } });
const field = (body: unknown, name: string) => (body && typeof body === "object" && name in body ? (body as Record<string, unknown>)[name] : undefined);

/** Orcling calls as the server keeps them: the owner's app alone, by its secret, claims, renews, answers or fails. */
export class StandInChatCalls {
  /** How long a claim lasts without renewal; a fixture shortens it to show an uncertain call. */
  leaseMs = 60_000;
  readonly #calls = new Map<string, Call>();

  constructor(private readonly deps: { deliver(record: StandInChatRecord, message: TeamMessage): void; readable(record: StandInChatRecord, who: string): boolean }) {}

  /** Records the call a message carries, which the message then shows. */
  record(record: StandInChatRecord, message: TeamMessage, who: string, wire: unknown): void {
    const id = field(wire, "id"),
      secret = field(wire, "runnerSecret");
    if (typeof id !== "string" || typeof secret !== "string") return;
    const owner = actorPerson(message.actor)!;
    this.#calls.set(id, {
      record,
      messageId: message.id,
      ownerWho: who,
      owner,
      localOrclingId: String(field(wire, "localOrclingId")),
      name: String(field(wire, "name")),
      look: field(wire, "look") as OrclingLook,
      state: "pending",
      digest: digestOf(secret),
      attemptId: null,
      leaseUntil: null,
      reason: null,
      answerId: null,
    });
    message.call = this.#public(this.#calls.get(id)!);
  }

  route(path: string, method: string, who: string, body: unknown): Reply | null {
    const match = /^\/chat\/calls\/([^/]+)(?:\/(claim|heartbeat|answer|fail|retry))?$/.exec(path);
    if (!match) return null;
    const call = this.#calls.get(decodeURIComponent(match[1] ?? ""));
    if (!call || call.ownerWho !== who || !this.deps.readable(call.record, who)) return absent();
    const step = match[2] ?? "";
    if (method === "GET" && step === "") return { status: 200, body: this.#owner(call) };
    if (method !== "POST" || step === "") return absent();
    if (step === "retry") return this.#retry(call, String(field(body, "runnerSecret") ?? ""));
    return this.#attempt(call, step, body);
  }

  /** A step of the running attempt, which only the app holding the secret, on that attempt, may take. */
  #attempt(call: Call, step: string, body: unknown): Reply {
    if (digestOf(String(field(body, "runnerSecret") ?? "")) !== call.digest) return refused("Another app holds this call.");
    const attemptId = String(field(body, "attemptId") ?? "");
    if (step === "claim") return this.#claim(call, attemptId);
    if (call.attemptId !== attemptId) return refused("This answer is no longer the call's attempt.");
    if (step === "heartbeat") return this.#renew(call);
    if (step === "answer") return this.#answer(call, String(field(body, "body") ?? ""));
    return this.#fail(call, String(field(body, "reason") ?? ""));
  }

  #claim(call: Call, attemptId: string): Reply {
    if (!(call.state === "pending" || (call.state === "running" && call.attemptId === attemptId))) return refused("This call isn't waiting to run.");
    Object.assign(call, { state: "running", attemptId, leaseUntil: Date.now() + this.leaseMs });
    this.#changed(call);
    const calling = call.record.messages.find((message) => message.id === call.messageId)!;
    const messages = call.record.messages.filter((message) => message.seq <= calling.seq).slice(-51);
    const speaker = (message: TeamMessage) => (message.actor.kind === "orcling" ? `${message.actor.name} (${message.actor.owner.name}'s Orcling)` : (message.actor.person?.name ?? "Former member"));
    return {
      status: 200,
      body: {
        call: this.#public(call),
        context: {
          callingMessageId: call.messageId,
          messages: messages.map((message) => ({ id: message.id, seq: message.seq, speaker: speaker(message), body: message.body, files: message.files.map(({ name, bytes }) => ({ name, bytes })) })),
        },
      },
    };
  }

  #renew(call: Call): Reply {
    if (call.state !== "running") return refused("This call isn't running.");
    call.leaseUntil = Date.now() + this.leaseMs;
    return { status: 204, body: null };
  }

  #answer(call: Call, text: string): Reply {
    const prior = call.answerId ? call.record.messages.find((message) => message.id === call.answerId) : undefined;
    if (prior) return { status: 200, body: prior };
    if (call.state !== "running") return refused("This call isn't running.");
    const answer: TeamMessage = {
      id: randomUUID(),
      channelId: call.record.conversation.id,
      seq: ++call.record.conversation.lastMessageSeq,
      actor: { kind: "orcling", owner: call.owner, localOrclingId: call.localOrclingId, name: call.name, look: call.look, callId: [...this.#calls].find(([, each]) => each === call)![0] },
      body: text,
      files: [],
      reactions: [],
      replyTo: null,
      pinned: null,
      call: null,
      createdAt: new Date().toISOString(),
    };
    call.record.messages.push(answer);
    call.record.conversation.lastMessageAt = answer.createdAt;
    Object.assign(call, { state: "answered", answerId: answer.id, leaseUntil: null });
    this.#changed(call);
    this.deps.deliver(call.record, answer);
    return { status: 200, body: answer };
  }

  #fail(call: Call, reason: string): Reply {
    if (call.state !== "running") return refused("This call isn't running.");
    Object.assign(call, { state: "failed", leaseUntil: null, reason });
    this.#changed(call);
    return { status: 200, body: this.#owner(call) };
  }

  #retry(call: Call, secret: string): Reply {
    const state = this.#state(call);
    if (state !== "failed" && state !== "uncertain") return refused("This call can't be tried again now.");
    Object.assign(call, { state: "pending", digest: digestOf(secret), attemptId: null, leaseUntil: null, reason: null });
    this.#changed(call);
    return { status: 200, body: this.#owner(call) };
  }

  #state(call: Call): TeamOrclingCall["state"] {
    return call.state === "running" && call.leaseUntil !== null && call.leaseUntil < Date.now() ? "uncertain" : call.state;
  }

  #public(call: Call): TeamOrclingCall {
    const id = [...this.#calls].find(([, each]) => each === call)![0];
    return { id, owner: call.owner, localOrclingId: call.localOrclingId, name: call.name, look: call.look, state: this.#state(call) };
  }

  #owner(call: Call) {
    const state = this.#state(call);
    return { call: this.#public(call), reason: call.reason, canRetry: state === "failed" || state === "uncertain" };
  }

  /** The calling message shows the call as it now is, for everyone who reads it. */
  #changed(call: Call): void {
    const calling = call.record.messages.find((message) => message.id === call.messageId);
    if (calling) calling.call = this.#public(call);
  }

  /** Whose app a call belongs to, for a fixture that checks who may run it. */
  ownerOf(callId: string): string | null {
    const call = this.#calls.get(callId);
    return call ? userOf(call.ownerWho) : null;
  }
}

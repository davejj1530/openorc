import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SeatOperation } from "@openorc/protocol";
import type { WireOrganizationBilling } from "../organization-billing-wire.js";
import type { StandInSpaces } from "./stand-in-spaces.js";
import { userOf } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Seat = WireOrganizationBilling["seats"][number];
type Person = { name: string; image: string | null };
type Preview = { spaceId: string; actor: string; seatId: string; memberId: string | null; revision: string; expires: number };
type Operation = { scope: Preview; body: { id: string; previewToken: string }; operation: SeatOperation };
interface Deps {
  spaces: StandInSpaces;
  records: Map<string, WireOrganizationBilling>;
  now(): number;
  changed(spaceId: string): void;
}
const refuse = (message: string): Reply => ({ status: 409, body: { message } });
const ok = (body: unknown): Reply => ({ status: 200, body });

export class StandInSeatAssignments {
  enabled = false;
  pending = false;
  previousHolderAfter: "grace" | "frozen" = "grace";
  person: (email: string) => Person = (email) => ({ name: email, image: null });
  paysForPro: (email: string) => boolean = () => false;
  readonly #previews = new Map<string, Preview>();
  readonly #operations = new Map<string, Operation>();
  constructor(private readonly deps: Deps) {}

  fact(spaceId: string, email: string) {
    if (!this.enabled) return undefined;
    const member = this.deps.spaces.member(spaceId, email);
    const seat = this.deps.records.get(spaceId)?.seats.find((seat) => seat.assignment.kind === "member" && seat.assignment.memberId === member?.id);
    return { id: seat?.id ?? null, paysForPro: this.paysForPro(email) };
  }

  route(method: string, path: string, spaceId: string, actor: string, body: unknown): Reply | null {
    const preview = /^\/organization\/seats\/([^/]+)\/preview$/.exec(path);
    const assignment = /^\/organization\/seats\/([^/]+)$/.exec(path);
    const operation = /^\/organization\/billing\/operations\/([^/]+)$/.exec(path);
    if (!preview && !assignment && !operation) return null;
    if (!this.enabled) return { status: 404, body: { message: "Not found." } };
    if (method === "POST" && preview) return this.#preview(spaceId, actor, decodeURIComponent(preview[1]!), body);
    if (method === "PATCH" && assignment) return this.#assign(spaceId, actor, decodeURIComponent(assignment[1]!), body);
    if (method === "GET" && operation) {
      const saved = this.#operations.get(decodeURIComponent(operation[1]!));
      return saved?.scope.spaceId === spaceId ? ok(saved.operation) : { status: 404, body: { message: "Unknown operation." } };
    }
    return { status: 404, body: { message: "Not found." } };
  }

  #preview(spaceId: string, actor: string, seatId: string, body: unknown): Reply {
    const input = z.strictObject({ memberId: z.string().nullable() }).safeParse(body);
    if (!input.success) return refuse("Choose a person.");
    const billing = this.deps.records.get(spaceId);
    const seat = billing?.seats.find((seat) => seat.id === seatId);
    const invalid = this.#invalid(spaceId, seat, input.data.memberId);
    if (invalid || !billing || !seat) return refuse(invalid ?? "That seat has changed. Review the change again.");
    const token = randomUUID();
    const now = this.deps.now();
    const boundary = seat.period ? Date.parse(seat.period.endsAt) : Infinity;
    const expires = boundary > now ? Math.min(now + 60_000, boundary) : now + 60_000;
    this.#previews.set(token, { spaceId, actor, seatId, memberId: input.data.memberId, revision: billing.revision, expires });
    const from = seat.assignment.kind === "member" || seat.assignment.kind === "person" ? seat.assignment : null;
    const holderAfter = from?.paysForPro ? "pro" : this.previousHolderAfter;
    const previousHolderAfter = from ? holderAfter : null;
    const member = this.deps.spaces.teams.get(spaceId)?.members.find((member) => member.id === input.data.memberId);
    return ok({
      token,
      expiresAt: new Date(expires).toISOString(),
      asOf: new Date(now).toISOString(),
      seat: structuredClone(seat),
      to: member ? { memberId: member.id, person: { id: userOf(member.email), email: member.email, ...this.person(member.email) } } : null,
      previousHolderAfter,
      graceUntil: previousHolderAfter === "grace" ? new Date(now + 86_400_000).toISOString() : null,
      runningTurnsToStop: 0,
    });
  }

  #assign(spaceId: string, actor: string, seatId: string, body: unknown): Reply {
    const input = z.strictObject({ id: z.uuid(), previewToken: z.string() }).safeParse(body);
    if (!input.success) return refuse("Review the change again.");
    const prior = this.#operations.get(input.data.id);
    if (prior) return this.#replay(prior, spaceId, actor, seatId, input.data.previewToken);
    const preview = this.#previews.get(input.data.previewToken);
    const billing = this.deps.records.get(spaceId);
    if (!preview || preview.spaceId !== spaceId || preview.actor !== actor || preview.seatId !== seatId || preview.expires <= this.deps.now() || billing?.revision !== preview.revision)
      return refuse("That seat has changed. Review the change again.");
    if ([...this.#operations.values()].some((work) => work.scope.seatId === seatId && work.operation.state === "pending")) return refuse("Moving the seat.");
    const invalid = this.#invalid(
      spaceId,
      billing.seats.find((seat) => seat.id === seatId),
      preview.memberId,
    );
    if (invalid) return refuse(invalid);
    const saved: Operation = { scope: preview, body: input.data, operation: { id: input.data.id, kind: "assignment", state: "pending", message: null } };
    this.#operations.set(input.data.id, saved);
    if (!this.pending) this.settle(input.data.id);
    return ok(saved.operation);
  }

  #replay(prior: Operation, spaceId: string, actor: string, seatId: string, previewToken: string): Reply {
    const same = prior.scope.spaceId === spaceId && prior.scope.actor === actor && prior.scope.seatId === seatId && prior.body.previewToken === previewToken;
    return same ? ok(prior.operation) : refuse("That request was already used for a different change.");
  }

  settle(id: string): void {
    const saved = this.#operations.get(id);
    if (!saved || saved.operation.state !== "pending") return;
    const { spaceId, seatId, memberId } = saved.scope;
    const billing = this.deps.records.get(spaceId)!;
    const seat = billing.seats.find((seat) => seat.id === seatId)!;
    const invalid = this.#invalid(spaceId, seat, memberId);
    if (invalid) {
      saved.operation = { ...saved.operation, state: "failed", message: invalid };
      this.deps.changed(spaceId);
      return;
    }
    const member = this.deps.spaces.teams.get(spaceId)?.members.find((member) => member.id === memberId);
    seat.assignment = member
      ? { kind: "member", memberId: member.id, person: { id: userOf(member.email), email: member.email, ...this.person(member.email) }, paysForPro: this.paysForPro(member.email) }
      : { kind: "available" };
    billing.revision = randomUUID();
    billing.available = billing.seats.filter((seat) => seat.assignment.kind === "available" && seat.retiresAt === null).length;
    saved.operation = { ...saved.operation, state: "complete" };
    this.deps.changed(spaceId);
  }

  #invalid(spaceId: string, seat: Seat | undefined, memberId: string | null): string | null {
    if (!seat || seat.assignment.kind === "invitation") return "That seat has changed. Review the change again.";
    if (memberId === null) return seat.assignment.kind === "available" ? "That seat is already available." : null;
    const billing = this.deps.records.get(spaceId)!;
    if (!["live", "ending"].includes(billing.subscription?.standing ?? "") || seat.retiresAt) return "Pay for seats before giving one to a person.";
    if (!this.deps.spaces.teams.get(spaceId)?.members.some((member) => member.id === memberId)) return "That person is no longer in this organization.";
    if (billing.seats.some((seat) => seat.assignment.kind === "member" && seat.assignment.memberId === memberId)) return "That person already has a seat in this organization.";
    return null;
  }
}

import { userOf, type StandInSpaces, type StandInTeam } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
interface MembershipRequest {
  method: string;
  path: string;
  space: string | null;
  who: string;
  body: Record<string, unknown>;
  spaces: StandInSpaces;
  recipients: string[];
  tell(who: string, topics: string[], space?: string): void;
}
const refuse = (status: number, message: string): Reply => ({ status, body: { message } });
const done: Reply = { status: 204, body: null };

/** Mutations run synchronously so the stand-in serializes its last-admin check and write. */
export function membershipRoute(input: MembershipRequest): Reply | null {
  const { method, path, spaces, who } = input;
  const leaving = method === "POST" && path === "/organization/leave";
  const deleting = method === "DELETE" && path === "/settings/organization";
  const target = /^\/organization\/members\/([^/]+)$/.exec(path)?.[1];
  if (!leaving && !deleting && !(target && ["PATCH", "DELETE"].includes(method))) return null;
  const space = spaces.resolve(who, input.space);
  if (typeof space !== "string") return space;
  const team = spaces.teams.get(space);
  if (!team) return refuse(409, deleting ? "Your personal space goes with your account, so it can't be deleted on its own." : "Your personal space is yours alone, so it can't be left.");
  const viewer = spaces.member(space, who);
  if (!leaving && viewer?.role !== "admin") return refuse(403, "Only an admin can do that.");
  const before = team.members.map((member) => member.email);
  const reply = deleting ? deleteOrganization(input, space, team) : changeMember(input, space, team, leaving ? viewer?.id : target, leaving);
  if (reply.status < 300) publishChange(input, space, before, deleting);
  return reply;
}

function publishChange(input: MembershipRequest, space: string, members: string[], deleted: boolean): void {
  for (const email of members) input.tell(email, ["spaces", "members", "projects"], space);
  if (deleted) for (const email of input.recipients) input.tell(email, ["invitations"]);
}

function deleteOrganization(input: MembershipRequest, space: string, team: StandInTeam): Reply {
  if (typeof input.body["name"] !== "string" || input.body["name"].trim() !== team.name) return refuse(400, `Type ${team.name} exactly to delete it.`);
  input.spaces.deleteOrganization(space);
  return done;
}

function changeMember(input: MembershipRequest, space: string, team: StandInTeam, memberId: string | undefined, leaving: boolean): Reply {
  const member = team.members.find((member) => member.id === memberId);
  if (!member) return refuse(404, "That person isn't in this organization.");
  const removing = leaving || input.method === "DELETE";
  const role = input.body["role"];
  if (!removing && role !== "admin" && role !== "member") return refuse(400, "Choose Admin or Member.");
  if (member.role === "admin" && (removing || role === "member") && team.members.filter((member) => member.role === "admin").length === 1)
    return refuse(409, leaving ? "You're the only admin. Make someone else an admin first, or delete the organization." : "Keep at least one admin in the organization.");
  if (removing) {
    input.spaces.removeMember(space, member.email);
    return done;
  }
  if (role === "admin" || role === "member") member.role = role;
  return { status: 200, body: { id: member.id, userId: userOf(member.email), organizationId: space, role: member.role, createdAt: member.createdAt } };
}

import { z } from "zod";
import type { StandInSpaces } from "./stand-in-spaces.js";

const policy = z.object({ everyone: z.boolean(), memberIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length) }).strict();
type Reply = { status: number; body: unknown };

export function projectAccessRoute(input: {
  method: string;
  path: string;
  space: string | null;
  who: string;
  body: Record<string, unknown>;
  spaces: StandInSpaces;
  accessChanged(space: string): void;
  tell(who: string, topics: string[], space?: string): void;
}): Reply | null {
  const id = /^\/projects\/([^/]+)\/access$/.exec(input.path)?.[1];
  if (!id || !["GET", "PUT"].includes(input.method)) return null;
  const { spaces, who } = input;
  const space = spaces.resolve(who, input.space);
  if (typeof space !== "string") return space;
  if (spaces.teams.has(space) && spaces.member(space, who)?.role !== "admin") return { status: 403, body: { message: "Only an admin can do that." } };
  const project = spaces.project(space, decodeURIComponent(id));
  if (!project) return { status: 404, body: { message: "That project isn't here." } };
  if (input.method === "PUT") {
    const parsed = policy.safeParse(input.body);
    if (!parsed.success) return { status: 400, body: { message: "Choose everyone or a list of people." } };
    const members = spaces.teams.get(space)?.members ?? [];
    if (parsed.data.memberIds.some((id) => !members.some((member) => member.id === id))) return { status: 404, body: { message: "That person isn't in this organization." } };
    Object.assign(project, parsed.data);
    input.accessChanged(space);
    for (const email of spaces.readers(space)) input.tell(email, ["projects", "threads"], space);
  }
  return { status: 200, body: { projectId: project.id, everyone: project.everyone, memberIds: [...project.memberIds] } };
}

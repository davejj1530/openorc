import { useEffect, useState } from "react";
import type { HarnessId, LeftOutSkill } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { core } from "../lib/rpc";

const SEEN = "openorc.skillsLeftOutSaid";

const keyOf = (agent: string, skill: LeftOutSkill) => `${agent}\u0000${skill.name}\u0000${skill.cause}`;

function said(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * A cloud thread's quiet line for the person's skills its last send left out because this Mac couldn't read them, each
 * with why. Said once for a skill and its cause, and again only when the cause changes; it never holds a send.
 */
export function SkillsLeftOut({ agent, on }: { agent: string | null; on: boolean }) {
  const left = useRpc("hostedSkills.leftOut", { agent: (agent ?? "claude") as HarnessId }, { enabled: on && Boolean(agent), staleTime: 0 });
  const refetch = left.refetch;
  const [shown, setShown] = useState<LeftOutSkill[]>([]);
  useEffect(() => {
    if (!on) return;
    return core.onPush((event) => {
      if (event.type === "invalidate" && event.keys.includes("hostedSkillsLeftOut")) void refetch();
    });
  }, [on, refetch]);
  useEffect(() => {
    if (!agent || !left.data?.length) return;
    const before = said();
    const fresh = left.data.filter((skill) => !before.has(keyOf(agent, skill)));
    if (!fresh.length) return;
    for (const skill of fresh) before.add(keyOf(agent, skill));
    localStorage.setItem(SEEN, JSON.stringify([...before]));
    setShown(fresh);
  }, [agent, left.data]);
  if (!on || !shown.length) return null;
  return (
    <div role="status" className="text-xs text-ink-3 px-1">
      {shown.map((skill) => (skill.name === null ? `Sent without your skills: ${skill.cause}` : `Sent without your skill ${skill.name}: ${skill.cause}`)).join(" ")}
    </div>
  );
}

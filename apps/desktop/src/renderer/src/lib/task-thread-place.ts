import type { OnlineTask } from "@openorc/protocol";

/**
 * Where a team task's thread opens: where its work already runs (a cloud thread, this person's computer, someone
 * else's), or, with none yet and a server that lets it open on a computer, the person's choice of the two.
 */
export type TaskThreadPlace = { kind: "cloud" } | { kind: "here" } | { kind: "elsewhere"; name: string } | { kind: "choose" };

export function taskThreadPlace(task: OnlineTask, me: string | null, computerServed: boolean): TaskThreadPlace {
  if (task.computer) return task.computer.userId === me ? { kind: "here" } : { kind: "elsewhere", name: task.computer.name.trim().split(/\s+/)[0] || task.computer.name };
  if (!computerServed || task.execution.state !== "none") return { kind: "cloud" };
  return { kind: "choose" };
}

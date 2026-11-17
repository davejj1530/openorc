import type { Message } from "./stand-in-threads.js";

/** Why a new message waits paused (a join that missed its turn), and the task context it was sent with. */
export function heldWith(paused: boolean, body: Record<string, unknown>): Pick<Message, "pause" | "task"> {
  const missed = paused && typeof body["expectedTurnId"] === "string";
  return { pause: missed ? { kind: "join", message: "The turn this was sent to has ended." } : null, task: (body["task"] as Message["task"]) ?? null };
}

/** The settings a message was sent with, kept on it for the turn it starts. */
export const sentSettings = (body: Record<string, unknown>): Pick<Message, "settings"> =>
  typeof body["settings"] === "object" && body["settings"] !== null ? { settings: body["settings"] as Message["settings"] } : {};

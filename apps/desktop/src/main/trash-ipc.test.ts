import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { TrashClient } from "../core/trash";
import { installTrash } from "./trash-ipc";

/** Main and the core's client joined back to back, as the utility channel joins them. */
function channel(trashItem: (file: string) => Promise<void>) {
  const child = Object.assign(new EventEmitter(), { postMessage: (message: unknown) => void client.receive(message) });
  const client = new TrashClient((message) => child.emit("message", message));
  installTrash(child, trashItem);
  return client;
}

it("moves what the core asks to the Trash and answers each request with its own outcome", async () => {
  const trashItem = vi.fn(async (file: string) => {
    if (file.endsWith("locked")) throw new Error("The item is locked.");
  });
  const client = channel(trashItem);
  await expect(client.move("/Users/me/.agents/skills/notes")).resolves.toBeUndefined();
  await expect(client.move("/Users/me/.agents/skills/locked")).rejects.toThrow("The item is locked.");
  await expect(client.move("relative/notes")).rejects.toThrow("Only a full path can be moved to the Trash.");
  expect(trashItem.mock.calls).toEqual([["/Users/me/.agents/skills/notes"], ["/Users/me/.agents/skills/locked"]]);
});

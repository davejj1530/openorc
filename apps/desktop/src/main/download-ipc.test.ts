import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { DownloadClient } from "../core/download";
import { installDownloads } from "./download-ipc";

function channel(save: (name: string) => Promise<string | null>) {
  const child = Object.assign(new EventEmitter(), { postMessage: (message: unknown) => void client.receive(message) });
  const client = new DownloadClient((message) => child.emit("message", message));
  installDownloads(child, save);
  return client;
}

it("returns each native Save As choice and cancellation to its own request", async () => {
  const save = vi.fn(async (name: string) => (name === "cancel.txt" ? null : `/tmp/example/${name}`));
  const client = channel(save);
  expect(await Promise.all([client.choose("notes.txt"), client.choose("cancel.txt")])).toEqual(["/tmp/example/notes.txt", null]);
  await expect(client.choose("../outside.txt")).rejects.toThrow("Choose a filename without a folder path.");
  expect(save.mock.calls).toEqual([["notes.txt"], ["cancel.txt"]]);
});

it("preserves a native dialog failure instead of treating it as a cancellation", async () => {
  const client = channel(async () => {
    throw new Error("The destination couldn't open.");
  });
  await expect(client.choose("notes.txt")).rejects.toThrow("The destination couldn't open.");
});

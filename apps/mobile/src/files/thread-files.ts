import type { AssetRef, ConversationScope } from "@openorc/protocol";

/** The capability a Mac shares once it lists and reads a phone's thread files. */
export const THREAD_FILES = "thread-files";

/** A thread's own folder, which the Mac resolves: its folder there, or a cloud thread's reading copy. */
export const threadScope = (threadId: string): ConversationScope => ({ kind: "thread", id: threadId });

/** A place's last segment, or the folder's own name at its root. */
export const placeName = (path: string, root: string): string => (path ? path.slice(path.lastIndexOf("/") + 1) : root);

/** The folder a place is in: its parent's place, empty at the root. */
export const parentPlace = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** An image of a thread's folder, by its place there, as the Mac serves it. */
export const threadFileAsset = (threadId: string, path: string): AssetRef => ({ kind: "thread-file", threadId, path });

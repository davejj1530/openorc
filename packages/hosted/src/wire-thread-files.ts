import { z } from "zod";
import type { Route } from "./wire.js";

/**
 * A cloud thread's files as the server reads them for anyone who reads the thread, without a Mac and without waking
 * its machine: the live folder while the machine is awake anyway, else its newest work save. The shapes are the app's
 * FileDirectory and FileRead without what only a Mac has (its paths, a file's version, a viewer URL).
 */
export const WireFilesSource = z.discriminatedUnion("from", [z.object({ from: z.literal("machine") }), z.object({ from: z.literal("save"), savedAt: z.string() })]);
export type WireFilesSource = z.infer<typeof WireFilesSource>;

export const WireThreadFolder = z.object({
  name: z.string(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(["directory", "file"]) })),
  source: WireFilesSource,
  unavailable: z.object({ message: z.string(), retry: z.boolean() }).optional(),
});
export type WireThreadFolder = z.infer<typeof WireThreadFolder>;

export const WireThreadFileRead = z.intersection(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), text: z.string(), size: z.number() }),
    z.object({ kind: z.literal("binary"), media: z.enum(["pdf", "image", "video", "audio", "other"]), mime: z.string(), size: z.number() }),
    z.object({ kind: z.literal("missing") }),
    z.object({ kind: z.literal("unreadable"), reason: z.string() }),
  ]),
  z.object({ source: WireFilesSource }),
);
export type WireThreadFileRead = z.infer<typeof WireThreadFileRead>;

export const WireThreadFileNames = z.object({ paths: z.array(z.string()), source: WireFilesSource });
export type WireThreadFileNames = z.infer<typeof WireThreadFileNames>;

const files = (threadId: string, rest = "") => `/hosted/threads/${encodeURIComponent(threadId)}/files${rest}`;
const route = <T>(path: string, reply: z.ZodType<T>): Route<T> => ({ method: "GET", path, reply });

export const THREAD_FILE_ROUTES = {
  /** A folder's entries; `path` "" is the root. Asked of a subthread, its folder's. */
  list: (threadId: string, path: string) => route(files(threadId, `?${new URLSearchParams({ path })}`), WireThreadFolder),
  /** Files by name, best first, at most `limit` (50). */
  search: (threadId: string, query: string, limit: number) => route(files(threadId, `/search?${new URLSearchParams({ query, limit: String(limit) })}`), WireThreadFileNames),
  read: (threadId: string, path: string) => route(files(threadId, `/read?${new URLSearchParams({ path })}`), WireThreadFileRead),
  /** A binary file's bytes, streamed, its ETag the file's git hash. */
  raw: (threadId: string, path: string) => files(threadId, `/raw?${new URLSearchParams({ path })}`),
};

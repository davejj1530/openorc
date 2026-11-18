import type { WireFilesSource } from "@openorc/hosted";
import { placeOf, type FileEntry, type FileMedia, type ThreadSummary } from "@openorc/protocol";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { cloud, useLinkState, useRpc } from "../client";
import { useOwnCloud } from "../cloud/use-own-cloud";
import { threadScope } from "./thread-files";

/**
 * Where a thread's files are read from: its Mac, which reads its own folder or a cloud thread's copy (the answers it
 * gave stay while it is out of reach), or, for a cloud thread while the Mac is out of reach, OpenOrc Cloud itself
 * through the phone's own session.
 */
export type FilesSource = "mac" | "cloud";

/** The source, or null while the Mac is out of reach and whether the cloud reads the thread's files is not known yet. */
export type FilesSourceNow = FilesSource | null;

/** A folder as the screens draw it, whichever source read it. `savedAt`: the save it was read from, none when live. */
export interface FolderView {
  name: string;
  entries: FileEntry[];
  unavailable?: { message: string; retry: boolean };
  savedAt: string | null;
}

/** A file as the screens draw it, whichever source read it. */
export type FileView = { kind: "file"; path: string; text: string } | { kind: "binary"; path: string; media: FileMedia; size: number } | { kind: "missing" } | { kind: "unreadable"; reason: string };

/** A read for a screen: what it gave, what went wrong, when it was read, and asking again. */
export interface Read<T> {
  data: T | undefined;
  error: Error | null;
  readAt: number;
  refetch: () => void;
}

const savedAtOf = (source: WireFilesSource) => (source.from === "save" ? source.savedAt : null);

function readOf<Q, T>(query: UseQueryResult<Q>, view: (data: Q) => T): Read<T> {
  return { data: query.data === undefined ? undefined : view(query.data), error: query.error, readAt: query.dataUpdatedAt, refetch: () => void query.refetch() };
}

/** The thread's files on OpenOrc Cloud, asked in the thread's own space; none while the phone's session does not hold it. */
function cloudFiles(threadId: string) {
  const hosted = cloud.hosted;
  if (!hosted?.threads.holds({ thread: threadId })) throw new Error("This thread isn't on OpenOrc Cloud.");
  const space = hosted.threads.row!(threadId).space;
  return {
    list: (path: string) => hosted.threadFiles.list(space, threadId, path),
    search: (query: string, limit: number) => hosted.threadFiles.search(space, threadId, query, limit),
    read: (path: string) => hosted.threadFiles.read(space, threadId, path),
  };
}

/**
 * The source the thread's files are read from now: the Mac while it is connected; OpenOrc Cloud for a cloud thread
 * while it is not, where the phone holds its own session and the server reads files itself; else the Mac, whose
 * answers stay with when they were read. Null while that is still being found out, so nothing is asked of either.
 * `host` names the Mac for the wait.
 */
export function useFilesSource(thread: ThreadSummary | null | undefined): { source: FilesSourceNow; live: boolean; host: string } {
  const link = useLinkState();
  const live = link.kind === "connected";
  const own = useOwnCloud();
  const elsewhere = Boolean(thread && placeOf(thread).elsewhere);
  const capabilities = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: !live && elsewhere && own, staleTime: 60_000 });
  const served = capabilities.data?.features.threadFiles?.available === true;
  const deciding = !live && (!thread || (elsewhere && own && capabilities.isPending));
  const read: FilesSource = !live && elsewhere && own && served ? "cloud" : "mac";
  return { source: deciding ? null : read, live, host: link.kind === "unpaired" ? "" : link.mac.name };
}

/** A folder of the thread's, from the source the screen reads. */
export function useFolder(threadId: string, path: string, source: FilesSourceNow): Read<FolderView> {
  const mac = useRpc("files.list", { scope: threadScope(threadId), path: path as never }, { enabled: source === "mac", staleTime: 30_000 });
  const fromCloud = useQuery({ queryKey: ["cloud.threadFiles.list", threadId, path], queryFn: () => cloudFiles(threadId).list(path), enabled: source === "cloud", retry: false });
  if (source !== "cloud") return readOf(mac, (folder) => ({ name: folder.name ?? "", entries: folder.entries, unavailable: folder.unavailable, savedAt: null }));
  return readOf(fromCloud, (folder) => ({
    name: folder.name,
    entries: folder.entries.map((entry) => ({ ...entry, path: entry.path as FileEntry["path"], ignored: false })),
    unavailable: folder.unavailable,
    savedAt: savedAtOf(folder.source),
  }));
}

/** A file of the thread's, from the source the screen reads. */
export function useFile(threadId: string, path: string, source: FilesSourceNow): Read<FileView> {
  const mac = useRpc("files.read", { scope: threadScope(threadId), path }, { enabled: source === "mac", staleTime: 30_000 });
  const fromCloud = useQuery({ queryKey: ["cloud.threadFiles.read", threadId, path], queryFn: () => cloudFiles(threadId).read(path), enabled: source === "cloud", retry: false });
  if (source !== "cloud")
    return readOf(mac, (read): FileView => {
      if (read.kind === "file") return { kind: "file", path: read.path, text: read.text };
      if (read.kind === "binary") return { kind: "binary", path: read.path, media: read.media, size: read.size };
      return read.kind === "missing" ? { kind: "missing" } : { kind: "unreadable", reason: read.reason };
    });
  return readOf(fromCloud, (read): FileView => {
    if (read.kind === "file") return { kind: "file", path, text: read.text };
    if (read.kind === "binary") return { kind: "binary", path, media: read.media, size: read.size };
    return read.kind === "missing" ? { kind: "missing" } : { kind: "unreadable", reason: read.reason };
  });
}

/** The thread's files whose names match, best first, from the source the screen reads. */
export function useNames(threadId: string, query: string, limit: number, source: FilesSourceNow): Read<string[]> {
  const mac = useRpc("files.search", { scope: threadScope(threadId), query, limit }, { enabled: source === "mac", placeholderData: keepPreviousData });
  const fromCloud = useQuery({
    queryKey: ["cloud.threadFiles.search", threadId, query],
    queryFn: () => cloudFiles(threadId).search(query, limit),
    enabled: source === "cloud",
    placeholderData: keepPreviousData,
    retry: false,
  });
  return source === "cloud" ? readOf(fromCloud, (names) => names.paths) : readOf(mac, (paths) => paths);
}

/** When the save a cloud thread's root was read from was made: the Mac's copy's, or the one the cloud read. None for a live folder. */
export function useSavedAt(threadId: string, elsewhere: boolean, source: FilesSourceNow, folder: FolderView | undefined): string | null {
  const copy = useRpc("threads.cloudCopy", { threadId }, { enabled: elsewhere && source === "mac", staleTime: 60_000 });
  if (!elsewhere) return null;
  return source === "cloud" ? (folder?.savedAt ?? null) : (copy.data?.asOf.at ?? null);
}

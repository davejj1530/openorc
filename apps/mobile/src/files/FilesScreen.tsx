import { panelToolLabels, relativeTime } from "@openorc/client";
import { placeOf, type FileEntry } from "@openorc/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useLinkState, useRpc } from "../client";
import { PanelTitle } from "../changes/PanelTitle";
import { ChevronRight, FilePlain, Folder, Search } from "../generated/icons";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { FilesNotice, readAt } from "./FilesNotice";
import { placeName, threadScope } from "./thread-files";

/** As many names as the desktop's search shows. */
const NAME_LIMIT = 50;

const openFolder = (threadId: string, path: string) => router.push({ pathname: "/files", params: { threadId, path } });
const openFile = (threadId: string, path: string) => router.push({ pathname: "/file", params: { threadId, path } });

/** One entry of a folder: a folder opens its own listing, a file opens to read; what git ignores is dimmed, as on the desktop. */
function EntryRow({ entry, onOpen }: { entry: FileEntry; onOpen: (entry: FileEntry) => void }) {
  const folder = entry.kind === "directory";
  const Icon = folder ? Folder : FilePlain;
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={folder ? `${entry.name}, folder` : entry.name}
      onPress={() => onOpen(entry)}
      className="h-touch flex-row items-center gap-3 px-5 active:bg-surface-2"
    >
      <Icon size={16} className="text-ink-4" />
      <Text numberOfLines={1} className={cn("min-w-0 flex-1 text-md", entry.ignored ? "text-ink-4" : "text-ink")}>
        {entry.name}
      </Text>
      {folder ? <ChevronRight size={16} className="text-ink-4" /> : null}
    </ListPressable>
  );
}

/** The files whose names match, best first, as the desktop's search lists them; each opens to read. */
function NameHits({ threadId, query }: { threadId: string; query: string }) {
  const names = useRpc("files.search", { scope: threadScope(threadId), query, limit: NAME_LIMIT }, { placeholderData: keepPreviousData });
  if (names.error && !names.data) return <FilesNotice text={names.error.message} />;
  if (!names.data) return <View className="items-center py-10">{<Spinner />}</View>;
  if (!names.data.length) return <FilesNotice text="No file names match." />;
  return names.data.map((path) => (
    <ListPressable key={path} accessibilityRole="button" accessibilityLabel={path} onPress={() => openFile(threadId, path)} className="h-touch flex-row items-center gap-3 px-5 active:bg-surface-2">
      <FilePlain size={16} className="text-ink-4" />
      <Text numberOfLines={1} ellipsizeMode="head" className="min-w-0 flex-1 font-mono text-xs text-ink-2">
        {path}
      </Text>
    </ListPressable>
  ));
}

/** The field atop a thread's files, which finds them by name. */
function SearchField({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  return (
    <View className="mx-5 mb-2 h-touch flex-row items-center gap-2 rounded-lg bg-surface-2 px-3">
      <Search size={16} className="text-ink-4" />
      <TextInput
        value={query}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        placeholder="Search files…"
        placeholderTextColorClassName="accent-ink-4"
        accessibilityLabel="Search files"
        className="min-w-0 flex-1 p-0 font-sans text-md text-ink"
      />
    </View>
  );
}

/**
 * A thread's files, a folder at a time, as the desktop's Files reads them through the Mac: the thread's folder there,
 * or a cloud thread's copy of its newest save, which the header says the age of. Read only. While the Mac is out of
 * reach, a folder read before stays with when it was read, and one never read waits for the Mac.
 */
export function FilesScreen() {
  const { threadId, path = "" } = useLocalSearchParams<{ threadId: string; path?: string }>();
  const thread = useRpc("threads.get", { id: threadId });
  const cloud = Boolean(thread.data && placeOf(thread.data).elsewhere);
  const link = useLinkState();
  const live = link.kind === "connected";
  const folder = useRpc("files.list", { scope: threadScope(threadId), path: path as never }, { staleTime: 30_000 });
  const copy = useRpc("threads.cloudCopy", { threadId }, { enabled: cloud, staleTime: 60_000 });
  const [query, setQuery] = useState("");
  const searching = !path && query.trim().length > 0;
  const title = placeName(path, folder.data?.name ?? panelToolLabels.file);
  const line = copy.data ? `Saved ${relativeTime(Date.parse(copy.data.asOf.at))}` : null;
  const open = (entry: FileEntry) => (entry.kind === "directory" ? openFolder(threadId, entry.path) : openFile(threadId, entry.path));
  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={{ headerTitle: () => <PanelTitle title={title} line={line} /> }} />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerClassName="pt-2 pb-8">
        {!path ? <SearchField query={query} onChange={setQuery} /> : null}
        {!live && folder.data ? <Text className="px-5 pb-1 text-sm text-ink-4">{readAt(folder.dataUpdatedAt)}</Text> : null}
        {searching ? <NameHits threadId={threadId} query={query.trim()} /> : <Listing folder={folder} live={live} host={link.kind === "unpaired" ? "" : link.mac.name} onOpen={open} />}
      </ScrollView>
    </View>
  );
}

/**
 * A folder's entries, or what stands in for them: the Mac's words when it could not list them or a cloud thread's copy
 * cannot be had (with Retry only where the Mac says it may help), the wait, or Empty folder.
 */
function Listing({ folder, live, host, onOpen }: { folder: ReturnType<typeof useRpc<"files.list">>; live: boolean; host: string; onOpen: (entry: FileEntry) => void }) {
  if (folder.data) {
    const { unavailable } = folder.data;
    if (unavailable) return <FilesNotice text={unavailable.message} onRetry={unavailable.retry && live ? () => void folder.refetch() : undefined} />;
    if (!folder.data.entries.length) return <FilesNotice text="Empty folder" />;
    return folder.data.entries.map((entry) => <EntryRow key={entry.path} entry={entry} onOpen={onOpen} />);
  }
  if (!live) return <FilesNotice text={`Waiting for ${host}`} />;
  if (folder.error) return <FilesNotice text={folder.error.message} onRetry={() => void folder.refetch()} />;
  return <View className="items-center py-10">{<Spinner />}</View>;
}

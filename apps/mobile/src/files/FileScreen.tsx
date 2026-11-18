import { formatBytes } from "@openorc/client";
import type { FileRead } from "@openorc/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useLinkState, useRpc } from "../client";
import { PanelTitle } from "../changes/PanelTitle";
import { FilePlain } from "../generated/icons";
import { ImageTile } from "../thread/images";
import { createSheetWindow, SheetWindowContext, windowScroll } from "../thread/sheet-window";
import { Mono } from "../ui/Mono";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { FilesNotice, readAt } from "./FilesNotice";
import { parentPlace, placeName, threadFileAsset, threadScope } from "./thread-files";

/** A file the phone shows rather than reads as text: an image as a tile that opens full screen, anything else by its name and size, as the desktop does. */
function Binary({ threadId, file }: { threadId: string; file: Extract<FileRead, { kind: "binary" }> }) {
  const name = placeName(file.path, "");
  if (file.media === "image") return <ImageTile asset={threadFileAsset(threadId, file.path)} label={name} />;
  return (
    <View accessible accessibilityLabel={`${name}, ${formatBytes(file.size)}`} className="flex-row items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
      <FilePlain size={18} className="text-ink-3" />
      <View className="min-w-0 flex-shrink">
        <Text numberOfLines={1} className="text-md text-ink">
          {name}
        </Text>
        <Text className="text-sm tabular-nums text-ink-3">{formatBytes(file.size)}</Text>
      </View>
    </View>
  );
}

/** What a read gave, in the desktop's words for a file that is gone or empty, and the Mac's for one it could not read. */
function Read({ threadId, read }: { threadId: string; read: FileRead }) {
  switch (read.kind) {
    case "file":
      return read.text ? <Mono text={read.text} tone="text-ink" /> : <FilesNotice text="This file is empty." />;
    case "binary":
      return <Binary threadId={threadId} file={read} />;
    case "missing":
      return <FilesNotice text="File not found. It may have moved or been deleted." />;
    case "unreadable":
      return <FilesNotice text={read.reason} />;
  }
}

/**
 * One of a thread's files, read through the Mac as the desktop's Files reads it, to read only. While the Mac is out of
 * reach, a file read before stays with when it was read; one never read waits for the Mac, and nothing shows in its place.
 */
export function FileScreen() {
  const { threadId, path } = useLocalSearchParams<{ threadId: string; path: string }>();
  const link = useLinkState();
  const live = link.kind === "connected";
  const read = useRpc("files.read", { scope: threadScope(threadId), path }, { staleTime: 30_000 });
  const folder = parentPlace(path);
  // A long file draws only the lines near the screen, so its block follows where the screen is scrolled.
  const [sheet] = useState(createSheetWindow);
  return (
    <SheetWindowContext.Provider value={sheet}>
      <Stack.Screen options={{ headerTitle: () => <PanelTitle title={placeName(path, "")} line={folder || null} /> }} />
      <ScrollView className="flex-1 bg-bg" {...windowScroll(sheet)}>
        <View ref={sheet.content} className="gap-2 px-3 pt-2 pb-8">
          {!live && read.data ? <Text className="px-2 text-sm text-ink-4">{readAt(read.dataUpdatedAt)}</Text> : null}
          <Body threadId={threadId} read={read} live={live} host={link.kind === "unpaired" ? "" : link.mac.name} />
        </View>
      </ScrollView>
    </SheetWindowContext.Provider>
  );
}

function Body({ threadId, read, live, host }: { threadId: string; read: ReturnType<typeof useRpc<"files.read">>; live: boolean; host: string }) {
  if (read.data) return <Read threadId={threadId} read={read.data} />;
  if (!live) return <FilesNotice text={`Waiting for ${host}`} />;
  if (read.error) return <FilesNotice text={read.error.message} onRetry={() => void read.refetch()} />;
  return <View className="items-center py-10">{<Spinner />}</View>;
}

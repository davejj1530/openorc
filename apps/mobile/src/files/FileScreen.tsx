import { formatBytes } from "@openorc/client";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useRpc } from "../client";
import { PanelHeader, usePanelParams } from "../panel/host";
import { FilePlain } from "../generated/icons";
import { CloudThreadFileTile, ImageTile } from "../thread/images";
import { createSheetWindow, SheetWindowContext, windowScroll } from "../thread/sheet-window";
import { Mono } from "../ui/Mono";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { FilesNotice, readAt } from "./FilesNotice";
import { useFile, useFilesSource, type FilesSourceNow, type FileView, type Read } from "./files-source";
import { parentPlace, placeName, threadFileAsset } from "./thread-files";

/**
 * A file the phone shows rather than reads as text: an image as a tile that opens full screen; anything else as the
 * desktop's Files shows it, its mark and its size, the name being the header's.
 */
function Binary({ threadId, file, source }: { threadId: string; file: Extract<FileView, { kind: "binary" }>; source: FilesSourceNow }) {
  const label = placeName(file.path, "");
  if (file.media === "image")
    return source === "cloud" ? <CloudThreadFileTile threadId={threadId} path={file.path} label={label} /> : <ImageTile asset={threadFileAsset(threadId, file.path)} label={label} />;
  return (
    <View accessible accessibilityLabel={formatBytes(file.size)} className="items-center gap-3 py-10">
      <FilePlain size={28} className="text-ink-3" />
      <Text className="text-sm tabular-nums text-ink-3">{formatBytes(file.size)}</Text>
    </View>
  );
}

/** What a read gave, in the desktop's words for a file that is gone or empty, and the Mac's for one it could not read. */
function ReadFile({ threadId, read, source }: { threadId: string; read: FileView; source: FilesSourceNow }) {
  switch (read.kind) {
    case "file":
      return read.text ? <Mono text={read.text} tone="text-ink" /> : <FilesNotice text="This file is empty." />;
    case "binary":
      return <Binary threadId={threadId} file={read} source={source} />;
    case "missing":
      return <FilesNotice text="File not found. It may have moved or been deleted." />;
    case "unreadable":
      return <FilesNotice text={read.reason} />;
  }
}

/**
 * One of a thread's files, to read only, from the source its folder reads: the Mac, or OpenOrc Cloud for a cloud thread
 * while the Mac is out of reach. Else a file read before stays with when it was read; one never read waits for the
 * Mac, and nothing shows in its place.
 */
export function FileScreen() {
  const { threadId, path } = usePanelParams<{ threadId: string; path: string }>();
  const thread = useRpc("threads.get", { id: threadId });
  const { source, live, host } = useFilesSource(thread.data);
  const read = useFile(threadId, path, source);
  const kept = source === "mac" && !live;
  const folder = parentPlace(path);
  // A long file draws only the lines near the screen, so its block follows where the screen is scrolled.
  const [sheet] = useState(createSheetWindow);
  return (
    <SheetWindowContext.Provider value={sheet}>
      <PanelHeader title={placeName(path, "")} line={folder || null} fromCloud={source === "cloud"} />
      <ScrollView className="flex-1 bg-bg" {...windowScroll(sheet)}>
        <View ref={sheet.content} className="gap-2 px-3 pt-2 pb-8">
          {kept && read.data ? <Text className="px-2 text-sm text-ink-4">{readAt(read.readAt)}</Text> : null}
          <Body threadId={threadId} read={read} source={source} reachable={!kept} host={host} />
        </View>
      </ScrollView>
    </SheetWindowContext.Provider>
  );
}

function Body({ threadId, read, source, reachable, host }: { threadId: string; read: Read<FileView>; source: FilesSourceNow; reachable: boolean; host: string }) {
  if (source === null) return <View className="items-center py-10">{<WorkingMark />}</View>;
  if (read.data) return <ReadFile threadId={threadId} read={read.data} source={source} />;
  if (!reachable) return <FilesNotice text={`Waiting for ${host}`} />;
  if (read.error) return <FilesNotice text={read.error.message} onRetry={read.refetch} />;
  return <View className="items-center py-10">{<WorkingMark />}</View>;
}

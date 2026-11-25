import { formatBytes } from "@openorc/client";
import type { HostedFileScope, TeamChatFile } from "@openorc/protocol";
import { createContext, useContext, useState } from "react";
import { Pressable, Share, View } from "react-native";
import { chatFileUri, cloud } from "../client";
import { failureMessage } from "../failure";
import { Download, FileText } from "../generated/icons";
import { ChatImageTile } from "../thread/images";
import { cn } from "../ui/cn";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";

/** Where the open conversation's files are read: the phone's own session, the organization and the conversation. */
export const ChatFileScopeContext = createContext<HostedFileScope | null>(null);

/** The open conversation's file place, while the phone's own session is ready; null before. */
export function chatFileScope(spaceId: string, conversationId: string): HostedFileScope | null {
  const status = cloud.hosted?.spaces.status();
  return status?.state === "ready" ? { accountId: status.userId, apiOrigin: status.apiOrigin, spaceId, destination: { kind: "chat", conversationId } } : null;
}

/** A file that is not an image: its name and size; a tap reads it once and offers it, to save or open elsewhere. */
function FileRow({ scope, file }: { scope: HostedFileScope | null; file: TeamChatFile }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offer = async () => {
    const hosted = cloud.hosted;
    if (!hosted || !scope) throw new Error("This file isn't available in this space.");
    await Share.share({ url: await chatFileUri(hosted, scope, file) });
  };
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${file.name}, ${formatBytes(file.bytes)}`}
        disabled={pending}
        onPress={() => {
          setPending(true);
          setError(null);
          void offer()
            .catch((failure: unknown) => setError(failureMessage(failure)))
            .finally(() => setPending(false));
        }}
        className="min-h-touch flex-row items-center gap-3 rounded-2xl bg-surface-2 px-3.5 py-2.5 active:opacity-60"
      >
        <FileText size={18} className="text-ink-3" />
        <View className="min-w-0 flex-shrink">
          <Text numberOfLines={1} className="text-md text-ink">
            {file.name}
          </Text>
          <Text className="text-sm tabular-nums text-ink-3">{formatBytes(file.bytes)}</Text>
        </View>
        {pending ? <WorkingMark /> : <Download size={16} className="text-ink-3" />}
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A message's files under its words, as the desktop shows them: images as tiles that open full screen, other files by name and size. */
export function ChatFiles({ files, mine }: { files: readonly TeamChatFile[]; mine: boolean }) {
  const scope = useContext(ChatFileScopeContext);
  if (!files.length) return null;
  return (
    <View className={cn("w-64 gap-1.5", mine && "self-end")}>
      {files.map((file) => (file.kind === "image" ? <ChatImageTile key={file.id} scope={scope} file={file} /> : <FileRow key={file.id} scope={scope} file={file} />))}
    </View>
  );
}

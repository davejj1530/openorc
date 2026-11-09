import { composerActivity, workspaceLabel } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useContext } from "react";
import { View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { HostContext } from "../connection/host-context";
import { ComposerPlane } from "../composer/ComposerPlane";
import { SendButton } from "../composer/SendButton";
import { useShareSettings } from "../composer/settings-bridge";
import { FolderOpen, Globe } from "../generated/icons";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { useNewSubthread } from "./use-new-subthread";

/** Where the subthread will work: its parent's project and folder, which it shares. */
function ParentPlace({ parent }: { parent: ThreadSummary }) {
  const projects = useRpc("projects.list", {});
  const project = projects.data?.find((each) => each.id === parent.projectId)?.name;
  const Icon = parent.projectId === WORKSPACE_ID ? Globe : FolderOpen;
  const place = [project, workspaceLabel(parent)].filter(Boolean).join(" · ");
  if (!place) return null;
  return (
    <View accessible accessibilityLabel={`Works in ${place}`} className="flex-row items-center gap-1.5 px-5">
      <Icon size={16} className="text-ink-4" />
      <Text numberOfLines={1} className="flex-1 text-detail text-ink-4">
        {place}
      </Text>
    </View>
  );
}

function SubthreadForm({ parent }: { parent: ThreadSummary }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const host = useContext(HostContext);
  const composerId = `new-subthread:${parent.id}`;
  const form = useNewSubthread(parent);
  useShareSettings(composerId, form.settings);
  const activity = composerActivity({ stopping: false, submitting: form.starting, generatingImage: false });
  const start = async () => {
    const threadId = await form.submit();
    // Left, or covered by another screen, while the Mac set the thread up: the person has moved on, so stay put.
    if (!threadId || !navigation.isFocused()) return;
    router.replace({ pathname: "/thread/[id]", params: host ? { id: threadId, host } : { id: threadId } });
  };
  return (
    <View className="flex-1 justify-end bg-bg">
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View className="gap-4" style={{ paddingBottom: insets.bottom + 8 }}>
          <View className="gap-2">
            <Text accessibilityRole="header" className="px-5 text-xl">
              {`What should we work on under ${parent.title}?`}
            </Text>
            <ParentPlace parent={parent} />
          </View>
          <View className="gap-2 px-3">
            {form.error ? (
              <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
                {form.error}
              </Text>
            ) : null}
            {!form.error && form.dimReason ? (
              <Text accessibilityRole="alert" className="px-1 text-sm text-ink-4">
                {form.dimReason}
              </Text>
            ) : null}
            <ComposerPlane
              composerId={composerId}
              skillScope={{ kind: "thread", id: parent.id }}
              settings={form.settings}
              draft={{ text: form.draft.prompt, images: form.draft.images }}
              uploading={form.uploading}
              placeholder="Ask OpenOrc to build, fix bugs, explore"
              autoFocus
              onText={form.setText}
              onRemoveImage={form.removeImage}
              onAttach={form.chooseImages}
            >
              {activity ? <Text className="text-sm text-ink-4">{activity}</Text> : null}
              <SendButton state="send" label="Start" disabled={!form.controls.canSend} onPress={() => void start()} onDimPress={form.explainDim} />
            </ComposerPlane>
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/**
 * Starts a thread under another from the phone, as the desktop's New subthread does: the composer above the keyboard,
 * on the parent's model and settings, working in the parent's folder. Start swaps this screen for the new subthread.
 */
export function NewSubthreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const parent = useRpc("threads.get", { id: threadId });
  if (parent.data) return <SubthreadForm key={parent.data.id} parent={parent.data} />;
  return (
    <View className="flex-1 items-center justify-center bg-bg px-8">
      {parent.isLoading ? <Spinner /> : <Text className="text-center text-lg text-ink-3">{parent.error?.message ?? "This thread is no longer available."}</Text>}
    </View>
  );
}

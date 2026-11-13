import { composerActivity } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useContext, useEffect, useState } from "react";
import { View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { HostContext } from "../connection/host-context";
import { ComposerPlane } from "../composer/ComposerPlane";
import { SendButton } from "../composer/SendButton";
import { useShareSettings } from "../composer/settings-bridge";
import { projectChoices, type ProjectChoice } from "../projects";
import { Text } from "../ui/Text";
import { rememberedProject, rememberProject } from "./drafts";
import { copyAge, openingProject } from "./new-thread-state";
import { NewThreadPickers } from "./NewThreadPickers";
import { useNewThread } from "./use-new-thread";

/** The new thread's picker sheets find its choices under this id. */
const COMPOSER_ID = "new-thread";

interface FormProps {
  projectId: string;
  choices: ProjectChoice[];
  onProject: (id: string) => void;
  /** How old the cloud brain's copy of the project is, said only once it is old. */
  copy: string | null;
}

function NewThreadForm({ projectId, choices, onProject, copy }: FormProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const form = useNewThread(projectId);
  const host = useContext(HostContext);
  useShareSettings(COMPOSER_ID, {
    ...form.settings,
    project: { chosen: projectId, choices, disabled: form.starting || form.uploading > 0, select: onProject },
  });
  // Undefined until the Mac's projects load; Workspace is always listed.
  const name = projectId === WORKSPACE_ID ? null : choices.find((choice) => choice.id === projectId)?.name;
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
          <Text accessibilityRole="header" className="px-5 text-xl">
            {name ? `What should we work on in ${name}?` : "What should we work on?"}
          </Text>
          <NewThreadPickers
            composerId={COMPOSER_ID}
            project={choices.find((choice) => choice.id === projectId)}
            place={form.settings.place?.chosen}
            starting={form.starting}
            uploading={form.uploading > 0}
          />
          {copy ? <Text className="-mt-2 px-5 text-sm text-ink-4">{copy}</Text> : null}
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
              composerId={COMPOSER_ID}
              skillScope={{ kind: "project", id: projectId }}
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
 * Starts a thread from the phone: the project (Workspace first, the one it was opened for chosen), then the desktop's
 * composer with its defaults, all held above the keyboard as on a thread. Each project keeps its own draft, so switching
 * projects switches drafts. Start swaps this screen for the new thread, streaming.
 */
export function NewThreadScreen() {
  const { projectId: opened } = useLocalSearchParams<{ projectId?: string }>();
  const projects = useRpc("projects.list", {});
  const choices = projectChoices(projects.data);
  const [chosen, setChosen] = useState(() => openingProject(opened, rememberedProject(), projects.data && choices));
  // A project removed on the Mac while the screen is open leaves it for Workspace.
  const projectId = projects.data && !choices.some((choice) => choice.id === chosen) ? WORKSPACE_ID : chosen;
  useEffect(() => rememberProject(projectId), [projectId]);
  // One form for every project; each project's draft survives a switch through the picker.
  const copy = copyAge(
    projects.data?.find((project) => project.id === projectId),
    Date.now(),
  );
  return <NewThreadForm projectId={projectId} choices={choices} onProject={setChosen} copy={copy} />;
}

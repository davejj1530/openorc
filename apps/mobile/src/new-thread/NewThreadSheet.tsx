import { composerActivity } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { ComposerPlane } from "../composer/ComposerPlane";
import { SendButton } from "../composer/SendButton";
import { useShareSettings } from "../composer/settings-bridge";
import { projectChoices, type ProjectChoice } from "../projects";
import { SheetStatusBar } from "../ui/SheetStatusBar";
import { Text } from "../ui/Text";
import { rememberedProject, rememberProject } from "./drafts";
import { openingProject } from "./new-thread-state";
import { ProjectPicker } from "./ProjectPicker";
import { useNewThread } from "./use-new-thread";

/** The model and mode sheets find this composer's settings under this id. */
const COMPOSER_ID = "new-thread";

interface FormProps {
  projectId: string;
  choices: ProjectChoice[];
  onProject: (id: string) => void;
}

function NewThreadForm({ projectId, choices, onProject }: FormProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const sheet = useNewThread(projectId);
  useShareSettings(COMPOSER_ID, sheet.settings);
  // Undefined until the Mac's projects load; Workspace is always listed.
  const name = projectId === WORKSPACE_ID ? null : choices.find((choice) => choice.id === projectId)?.name;
  const activity = composerActivity({ stopping: false, submitting: sheet.starting, generatingImage: false });
  const start = async () => {
    const threadId = await sheet.submit();
    // Closed, or covered by another screen, while the Mac set the thread up: the person has moved on, so stay put.
    if (!threadId || !navigation.isFocused()) return;
    router.back();
    router.push({ pathname: "/thread/[id]", params: { id: threadId } });
  };
  return (
    <ScrollView keyboardShouldPersistTaps="handled" className="flex-1 bg-bg" contentContainerClassName="gap-4 pt-6" contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
      <Text accessibilityRole="header" className="px-5 text-xl">
        {name ? `What should we work on in ${name}?` : "What should we work on?"}
      </Text>
      {/* An image on its way belongs to this project's draft, so the project holds until it lands. */}
      <ProjectPicker choices={choices} selected={projectId} disabled={sheet.starting || sheet.uploading > 0} onSelect={onProject} />
      <View className="gap-2 px-3">
        {sheet.error ? (
          <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
            {sheet.error}
          </Text>
        ) : null}
        <ComposerPlane
          composerId={COMPOSER_ID}
          settings={sheet.settings}
          draft={{ text: sheet.draft.prompt, images: sheet.draft.images }}
          uploading={sheet.uploading}
          editable={!sheet.starting}
          placeholder="Ask OpenOrc to build, fix bugs, explore"
          autoFocus
          onText={sheet.setText}
          onRemoveImage={sheet.removeImage}
          onAttach={sheet.chooseImages}
        >
          {activity ? <Text className="text-sm text-ink-4">{activity}</Text> : null}
          <SendButton state="send" label="Start" disabled={!sheet.controls.canSend} onPress={() => void start()} />
        </ComposerPlane>
      </View>
    </ScrollView>
  );
}

/**
 * Starts a thread from the phone: the project (Workspace first, the one it was opened for chosen), then the desktop's
 * composer with its defaults. Each project keeps its own draft, so switching projects switches drafts. Start opens the
 * new thread over Home, streaming.
 */
export function NewThreadSheet() {
  const { projectId: opened } = useLocalSearchParams<{ projectId?: string }>();
  const projects = useRpc("projects.list", {});
  const choices = projectChoices(projects.data);
  const [chosen, setChosen] = useState(() => openingProject(opened, rememberedProject(), projects.data && choices));
  // A project removed on the Mac while the sheet is open leaves it for Workspace.
  const projectId = projects.data && !choices.some((choice) => choice.id === chosen) ? WORKSPACE_ID : chosen;
  useEffect(() => rememberProject(projectId), [projectId]);
  return (
    <>
      <SheetStatusBar />
      <NewThreadForm key={projectId} projectId={projectId} choices={choices} onProject={setChosen} />
    </>
  );
}

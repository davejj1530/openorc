import { composerActivity } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { ComposerPlane } from "../composer/ComposerPlane";
import { SendButton } from "../composer/SendButton";
import { useShareSettings } from "../composer/settings-bridge";
import { projectChoices, spaceChoices, type ProjectChoice } from "../projects";
import { useSpaces } from "../spaces/use-spaces";
import { Text } from "../ui/Text";
import { rememberedProject, rememberProject } from "./drafts";
import { openingProject } from "./new-thread-state";
import { NewThreadPickers } from "./NewThreadPickers";
import { NewThreadStarting } from "./NewThreadStarting";
import { useNewThread } from "./use-new-thread";

/** The new thread's picker sheets find its choices under this id. */
const COMPOSER_ID = "new-thread";

interface FormProps {
  project: ProjectChoice;
  choices: ProjectChoice[];
  onProject: (id: string) => void;
}

function NewThreadForm({ project, choices, onProject }: FormProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const projectId = project.id;
  const form = useNewThread(project);
  useShareSettings(COMPOSER_ID, {
    ...form.settings,
    project: { chosen: projectId, choices, disabled: form.starting || form.uploading > 0, select: onProject },
  });
  const name = projectId === WORKSPACE_ID ? null : project.name;
  const activity = composerActivity({ stopping: false, submitting: form.starting, generatingImage: false });
  const start = async () => {
    const threadId = await form.submit();
    // Left, or covered by another screen, while the thread was set up: the person has moved on, so stay put.
    if (!threadId || !navigation.isFocused()) return;
    router.replace({ pathname: "/thread/[id]", params: { id: threadId } });
  };
  // A cloud start shows as the thread it is becoming until the server holds it; a failure brings the composer back.
  if (form.cloudStart) return <NewThreadStarting start={form.cloudStart} />;
  return (
    <View className="flex-1 justify-end bg-bg">
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View className="gap-4" style={{ paddingBottom: insets.bottom + 8 }}>
          <Text accessibilityRole="header" className="px-5 text-xl">
            {name ? `What should we work on in ${name}?` : "What should we work on?"}
          </Text>
          <NewThreadPickers composerId={COMPOSER_ID} project={project} starting={form.starting} uploading={form.uploading > 0} />
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
 * The projects a new thread may start in, as Home shows them: a space's, read from wherever the phone reaches it, its
 * cloud ones beside the Mac's; the Mac's alone without an account. `known` once they have loaded; a space's wait for it,
 * as a start cannot go to a project whose place is not known yet.
 */
function useProjectChoices(): { choices: ProjectChoice[]; known: boolean; space: boolean } {
  const account = useSpaces();
  const space = account.state === "ready" ? account.current : null;
  const projects = useRpc("projects.list", {}, { enabled: space === null });
  const spaceProjects = useRpc("spaces.projects", { spaceId: space?.id ?? "" }, { enabled: space !== null });
  if (space) return { choices: spaceProjects.data ? spaceChoices(space, spaceProjects.data) : [], known: spaceProjects.data !== undefined, space: true };
  return { choices: projectChoices(projects.data), known: projects.data !== undefined, space: false };
}

/**
 * Starts a thread from the phone: the project (in Personal, Workspace first; the one it was opened for chosen), then
 * the desktop's composer with its defaults, all held above the keyboard as on a thread. Each project keeps its own
 * draft, so switching projects switches drafts. Start swaps this screen for the new thread, streaming; on OpenOrc Cloud
 * the message and the start's step show first, until the server holds the thread.
 */
export function NewThreadScreen() {
  const { projectId: opened } = useLocalSearchParams<{ projectId?: string }>();
  const { choices, known, space } = useProjectChoices();
  const [chosen, setChosen] = useState(() => openingProject(opened, rememberedProject(), known ? choices : undefined));
  // A project gone from the list while the screen is open leaves it for the list's first; until the Mac's list loads,
  // the one chosen is trusted.
  const project = choices.find((choice) => choice.id === chosen) ?? (known ? choices[0] : { id: chosen, name: "" });
  const projectId = project?.id;
  useEffect(() => {
    if (known && projectId) rememberProject(projectId);
  }, [known, projectId]);
  if (!project || (space && !known)) return <View className="flex-1 bg-bg" />;
  // One form for every project; each project's draft survives a switch through the picker.
  return <NewThreadForm project={project} choices={choices} onProject={setChosen} />;
}

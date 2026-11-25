import { composerActivity } from "@openorc/client";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRpc } from "../client";
import { ComposerPlane } from "../composer/ComposerPlane";
import { SendButton } from "../composer/SendButton";
import { useShareSettings } from "../composer/settings-bridge";
import { useDictatedSend } from "../dictation/use-composer-dictation";
import { projectChoices, spaceChoices, type ProjectChoice } from "../projects";
import { useSpaces } from "../spaces/use-spaces";
import { Text } from "../ui/Text";
import { rememberedProject, rememberProject } from "./drafts";
import { openingProject } from "./new-thread-state";
import { useMacPainting } from "../look/use-mac-look";
import { NewThreadMark, NewThreadQuestion } from "./NewThreadQuestion";
import { NewThreadStage } from "./NewThreadStage";
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
  const navigation = useNavigation();
  const painted = useMacPainting();
  const projectId = project.id;
  const form = useNewThread(project);
  useShareSettings(COMPOSER_ID, {
    ...form.settings,
    project: { chosen: projectId, choices, disabled: form.starting || form.uploading > 0, select: onProject },
  });
  const activity = composerActivity({ stopping: false, submitting: form.starting, generatingImage: false });
  const start = async () => {
    const threadId = await form.submit();
    // Left, or covered by another screen, while the thread was set up: the person has moved on, so stay put.
    if (!threadId || !navigation.isFocused()) return;
    router.replace({ pathname: "/thread/[id]", params: { id: threadId } });
  };
  // Started while dictating, the thread waits for the last words.
  const startSpoken = useDictatedSend(COMPOSER_ID, () => void start());
  // A cloud start shows as the thread it is becoming until the server holds it; a failure brings the composer back.
  if (form.cloudStart) return <NewThreadStarting start={form.cloudStart} />;
  return (
    <NewThreadStage painted={painted}>
      <NewThreadMark />
      <NewThreadQuestion composerId={COMPOSER_ID} project={project} disabled={form.starting || form.uploading > 0} painted={painted} />
      <View className="gap-2">
        {form.error ? (
          <Text accessibilityRole="alert" className="text-center text-sm text-bad">
            {form.error}
          </Text>
        ) : null}
        {!form.error && form.dimReason ? (
          <Text accessibilityRole="alert" className="text-center text-sm text-ink-4">
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
          surface={painted ? "glass" : "hero"}
        >
          {activity ? <Text className="text-sm text-ink-4">{activity}</Text> : null}
          <SendButton state="send" label="Start" disabled={!form.controls.canSend} onPress={startSpoken} onDimPress={form.explainDim} />
        </ComposerPlane>
      </View>
    </NewThreadStage>
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
 * Starts a thread from the phone as the desktop's New thread does: the mark, the question with the project in it (in
 * Personal, Workspace first; the one it was opened for chosen) and the composer with its defaults, centred on the
 * screen above the keyboard, over the Mac's painting where it shows one. Each project keeps its own
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

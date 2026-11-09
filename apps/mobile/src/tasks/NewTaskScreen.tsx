import { projectGitView } from "@openorc/client";
import type { Project } from "@openorc/protocol";
import { router, useNavigation } from "expo-router";
import { useContext, useRef, useState } from "react";
import { ScrollView, TextInput, View, type TextInputInstance } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hostLink, useRpc, useRpcMutation } from "../client";
import { SheetPill } from "../changes/SheetParts";
import { HostContext } from "../connection/host-context";
import { OLDER_MAC_TASK_CREATES } from "../connection/link-connection";
import { useShares } from "../connection/use-shares";
import { failureMessage } from "../failure";
import { Folder } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { boardPriority, boardStatus } from "./board";
import { draftProject, newTaskInput, useTaskDraft } from "./new-task";
import { PriorityMark, TaskStatusMark } from "./TaskMarks";
import { Pill, PillMenu, PRIORITY_ORDER } from "./TaskProperties";

/** Why Create cannot go yet, or null. */
function blocker(input: { shares: boolean | null; projects: readonly Project[] | undefined; projectId: string | null; title: string }): string | null {
  if (input.shares === false) return OLDER_MAC_TASK_CREATES;
  if (input.projects && !input.projects.length) return "Add a project on your Mac to save tasks in it.";
  if (!input.projectId) return null;
  return input.title.trim() ? null : "Give the task a title.";
}

/** The new task's properties, as the task screen lays them out: it starts in the backlog, at a priority, in a project. */
function NewTaskProperties({
  projects,
  projectId,
  priority,
  onChange,
}: {
  projects: readonly Project[];
  projectId: string;
  priority: ReturnType<typeof useTaskDraft>[0]["priority"];
  onChange: ReturnType<typeof useTaskDraft>[1];
}) {
  const names = Object.fromEntries(projects.map((project) => [project.id, project.name]));
  return (
    <View className="flex-row flex-wrap gap-1.5">
      <View accessible accessibilityLabel={`Status ${boardStatus.backlog}`}>
        <Pill icon={<TaskStatusMark status="backlog" />} label={boardStatus.backlog} />
      </View>
      <PillMenu name="Priority" value={priority} values={PRIORITY_ORDER} words={boardPriority} icon={<PriorityMark priority={priority} />} onChange={(next) => onChange({ priority: next })} />
      <PillMenu
        name="Project"
        value={projectId}
        values={projects.map((project) => project.id)}
        words={names}
        icon={<Folder size={16} className="text-ink-4" />}
        onChange={(next) => onChange({ projectId: next })}
      />
    </View>
  );
}

/**
 * A new task from the phone, as the Mac's New task makes one: its title at the head, the backlog, a priority and a
 * project as pills, then its description as Markdown text. Create sits above the keyboard and opens the saved task in
 * this screen's place. The draft stays on the phone until it is saved, so leaving keeps it.
 */
export function NewTaskScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const host = useContext(HostContext);
  const [draft, change, clear] = useTaskDraft();
  const projects = useRpc("projects.list", {}).data;
  const settings = useRpc("app.settings.get", {}).data;
  const shares = useShares("task-details");
  const create = useRpcMutation("tasks.create");
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const description = useRef<TextInputInstance>(null);
  const projectId = draftProject(draft, projects);
  const why = blocker({ shares, projects, projectId, title: draft.title });
  const ready = Boolean(projectId && settings && shares !== false && !why);
  const save = async () => {
    if (saving) return;
    if (!ready || !projectId) {
      haptic.warn();
      return setSaid(why);
    }
    setSaving(true);
    setSaid(null);
    try {
      // A project whose git cannot be read cannot branch either: the task works in its checkout.
      const canBranch = await hostLink(host)
        .connection.call("projects.git", { id: projectId })
        .then(
          (git) => !projectGitView(git).cannotBranch,
          () => false,
        );
      const task = await create.mutateAsync(newTaskInput(draft, projectId, { canBranch, preferred: settings?.defaultWorkspaceMode }));
      clear();
      haptic.confirm();
      // Left while the Mac saved it: the person has moved on, so stay put.
      if (navigation.isFocused()) router.replace({ pathname: "/task/[id]", params: host ? { id: task.id, host } : { id: task.id } });
    } catch (failure) {
      haptic.fail();
      setSaid(failureMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <View className="flex-1 bg-bg">
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerClassName="gap-5 px-5 pt-3 pb-6">
        <View className="gap-3">
          <TextInput
            multiline
            scrollEnabled={false}
            autoFocus
            value={draft.title}
            onChangeText={(typed) => {
              change({ title: typed.replace(/\n/g, "") });
              setSaid(null);
            }}
            submitBehavior="submit"
            returnKeyType="next"
            onSubmitEditing={() => description.current?.focus()}
            maxLength={200}
            placeholder="Task title"
            placeholderTextColorClassName="accent-ink-4"
            accessibilityLabel="Task title"
            className="p-0 font-sans text-2xl text-ink"
          />
          {projects?.length && projectId ? <NewTaskProperties projects={projects} projectId={projectId} priority={draft.priority} onChange={change} /> : null}
        </View>
        <TextInput
          ref={description}
          multiline
          scrollEnabled={false}
          value={draft.spec}
          onChangeText={(typed) => change({ spec: typed })}
          placeholder="Add a description"
          placeholderTextColorClassName="accent-ink-4"
          accessibilityLabel="Task description"
          textAlignVertical="top"
          className="min-h-40 p-0 font-sans text-lg text-ink"
        />
      </ScrollView>
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View className="gap-2 px-5 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
          {said ? (
            <Text accessibilityRole="alert" className="px-1 text-sm text-ink-3">
              {said}
            </Text>
          ) : null}
          {shares === false && !said ? <Text className="px-1 text-sm text-ink-4">{OLDER_MAC_TASK_CREATES}</Text> : null}
          <SheetPill label={saving ? "Creating…" : "Create task"} dim={!ready} running={saving} onPress={() => void save()} />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

import { NEEDS_YOU_PAGE, threadStatus } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { router } from "expo-router";
import { Keyboard, View } from "react-native";
import { useRpc } from "../client";
import type { ProjectChoice } from "../projects";
import { cn } from "../ui/cn";
import { useColors } from "../ui/mode";
import { OpenOrcMark } from "../ui/OpenOrcMark";
import { Text } from "../ui/Text";
import { projectReach, useMacReach } from "./project-reach";

/** The mark over the question, as on the desktop: at rest in the faint ink, and the working cube while any agent works. */
export function NewThreadMark() {
  const colors = useColors();
  const threads = useRpc("threads.list", { filter: "active", orderBy: "activity", includeChildren: false, needsYou: true, limit: NEEDS_YOU_PAGE }, { refetchInterval: 60_000 });
  const working = threads.data?.some((thread) => threadStatus(thread)?.kind === "running") ?? false;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="mb-3.5 self-center">
      <OpenOrcMark size={44} color={working ? colors["working-ink"] : colors["ink-4"]} working={working} />
    </View>
  );
}

/**
 * The question, centred over the composer as a title over the one thing on the screen. The project in it is the
 * switch, as on the desktop: a word of the sentence, underlined, that opens the projects. Over a picture (`painted`)
 * the words keep a halo of the ground.
 */
export function NewThreadQuestion({ composerId, project, disabled, painted }: { composerId: string; project: ProjectChoice; disabled: boolean; painted: boolean }) {
  const colors = useColors();
  const away = projectReach(project, useMacReach());
  const outside = project.id === WORKSPACE_ID;
  const name = outside ? "a project" : project.name;
  const choose = () => {
    // The keyboard goes first: a focused prompt would keep it up over the sheet.
    Keyboard.dismiss();
    router.push({ pathname: "/project", params: { composerId } });
  };
  return (
    <Text
      accessibilityRole="header"
      className="text-center text-title text-ink"
      style={painted ? { textShadowColor: colors.bg, textShadowRadius: 18, textShadowOffset: { width: 0, height: 2 } } : undefined}
    >
      What should we work on {outside ? "outside" : "in"}{" "}
      <Text
        accessibilityRole="button"
        accessibilityLabel={away ? `Project, ${project.name}, ${away}` : `Project, ${project.name}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={choose}
        suppressHighlighting
        className={cn("text-title underline", away && "text-ink-3")}
        // Faint at rest, as the desktop's: the line marks the switch without competing with the words.
        style={{ textDecorationColor: colors["ink-4"] }}
      >
        {name}
      </Text>
      ?
    </Text>
  );
}

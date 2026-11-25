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

/** A space a line never breaks at. */
const GLUE = "\u00a0";

/** Words as one unit of a line: no break at their spaces, nor after their hyphens. */
const whole = (words: string) => words.replace(/ /g, GLUE).replace(/-/g, "-\u2060");

/**
 * The question, centred in the room over the composer as the screen's title. Its words break before "in" or
 * "outside" and never after: the project wraps whole with the word before it, as on the desktop, so a second line
 * starts where the sentence turns. The project in it is the switch: a word of the sentence, underlined, that opens the
 * projects. Over a picture (`painted`) the words keep a halo of the ground.
 */
export function NewThreadQuestion({ composerId, project, disabled, painted }: { composerId: string; project: ProjectChoice; disabled: boolean; painted: boolean }) {
  const colors = useColors();
  const away = projectReach(project, useMacReach());
  const outside = project.id === WORKSPACE_ID;
  const name = whole(outside ? "a project" : project.name);
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
      What should we work on {outside ? "outside" : "in"}
      {GLUE}
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

import { createContext, useContext, type ComponentProps } from "react";
import { ListPressable } from "../ui/ListPressable";

/** Inside a turn's open work: records that the reader chose it open. */
export const WorkChoice = createContext<(() => void) | null>(null);

/**
 * A pressable in the transcript. Its pressed state waits a beat, as a list row's does, so a scroll that starts on it does
 * not flash it. Inside a turn's open work, any press keeps the work open after the turn ends, as the desktop's does: the
 * reader was using it.
 */
export function TranscriptPressable({ onPress, ...props }: ComponentProps<typeof ListPressable>) {
  const choose = useContext(WorkChoice);
  return (
    <ListPressable
      {...props}
      onPress={(event) => {
        choose?.();
        onPress?.(event);
      }}
    />
  );
}

import { useStore } from "zustand";
import { createDictation, type DictationState } from "./dictation";
import { nativeRecognizer } from "./native-recognizer";

/** The phone's dictation: one recording at a time, recognized on the device. */
export const dictation = createDictation(nativeRecognizer);

export function useDictation<Picked>(pick: (state: DictationState) => Picked): Picked {
  return useStore(dictation.store, pick);
}

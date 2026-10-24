import { createElement, type ReactNode } from "react";
import { View } from "./react-native";

/**
 * Gestures in tests: a detector draws its child in a view that holds its gesture, and gestures do nothing; a test reads
 * a gesture's config there and calls the handlers it would run.
 */
export const GestureHandlerRootView = View;
export const GestureDetector = ({ gesture, children }: { gesture: unknown; children: ReactNode }) => createElement(View, { gesture }, children);
export const usePanGesture = (config: object) => ({ kind: "pan", config });
export const useTapGesture = (config: object) => ({ kind: "tap", config });
export const useSimultaneousGestures = (...gestures: object[]) => ({ gestures });

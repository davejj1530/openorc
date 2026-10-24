import { View } from "./react-native";

/** A screen with no notch or home indicator to keep clear of. */
export const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
export const SafeAreaView = View;

import { Platform } from "react-native";

/** What Apple calls the device the app runs on, for the words that name it. */
export const DEVICE = Platform.OS === "ios" && Platform.isPad ? "iPad" : "iPhone";

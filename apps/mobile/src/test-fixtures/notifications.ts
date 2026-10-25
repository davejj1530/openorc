/*
 * expo-notifications and expo-application in tests: iOS has not been asked, no token arrives, and nothing is
 * delivered. Tests that care about alerts stand in their own platform.
 */
export const DEFAULT_ACTION_IDENTIFIER = "expo.modules.notifications.actions.DEFAULT";
export const getPermissionsAsync = async () => ({ status: "undetermined" });
export const requestPermissionsAsync = async () => ({ status: "undetermined" });
export const getDevicePushTokenAsync = () => new Promise(() => undefined);
export const addPushTokenListener = () => ({ remove: () => undefined });
export const getIosPushNotificationServiceEnvironmentAsync = async () => null;
export const getPresentedNotificationsAsync = async () => [];
export const dismissNotificationAsync = async () => undefined;
export const setNotificationCategoryAsync = async () => undefined;
export const setNotificationHandler = () => undefined;
export const useLastNotificationResponse = () => null;
export const clearLastNotificationResponse = () => undefined;

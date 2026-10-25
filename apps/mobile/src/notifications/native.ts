import { getIosPushNotificationServiceEnvironmentAsync } from "expo-application";
import {
  addPushTokenListener,
  dismissNotificationAsync,
  getDevicePushTokenAsync,
  getPermissionsAsync,
  getPresentedNotificationsAsync,
  requestPermissionsAsync,
  setNotificationCategoryAsync,
  setNotificationHandler,
  type NotificationPermissionsStatus,
} from "expo-notifications";
import type { PushPlatform } from "./alerts";
import type { Delivered, Presentation } from "./foreground";
import { environmentOf, type Permission } from "./registration";
import { APPROVAL_CATEGORY, approvalActions } from "./taps";

const permissionOf = ({ status }: NotificationPermissionsStatus): Permission => (status === "granted" || status === "denied" ? status : "undetermined");

// expo-notifications gives the APNs token as hex; the Mac takes it lowercase.
const hex = (data: unknown) => String(data).toLowerCase();

/** iOS's alerts for this app through expo-notifications, and the build's push environment through expo-application. */
export const pushPlatform: PushPlatform = {
  permission: async () => permissionOf(await getPermissionsAsync()),
  ask: async () => permissionOf(await requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })),
  environment: async () => environmentOf(await getIosPushNotificationServiceEnvironmentAsync()),
  token: async () => hex((await getDevicePushTokenAsync()).data),
  onToken: (listener) => {
    const subscription = addPushTokenListener((token) => listener(hex(token.data)));
    return () => subscription.remove();
  },
};

/** Alerts this app delivered, by the data the extension left in them. */
export const notificationCenter: Delivered = {
  delivered: async () => (await getPresentedNotificationsAsync()).map(({ request }) => ({ id: request.identifier, data: request.content.data })),
  dismiss: dismissNotificationAsync,
};

/** At every launch: Allow and Deny for approvals, and whether an alert shows while the app is open. */
export function handleAlerts(present: (data: unknown) => Presentation): void {
  void setNotificationCategoryAsync(APPROVAL_CATEGORY, [...approvalActions]);
  setNotificationHandler({ handleNotification: async ({ request }) => present(request.content.data) });
}

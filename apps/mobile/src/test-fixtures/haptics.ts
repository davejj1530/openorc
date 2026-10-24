/** Haptics in tests: each call is recorded by its kind, in order, so a test can say which moment fired. */
export const felt: string[] = [];

export enum ImpactFeedbackStyle {
  Light = "light",
  Medium = "medium",
  Heavy = "heavy",
}
export enum NotificationFeedbackType {
  Success = "success",
  Warning = "warning",
  Error = "error",
}

export const selectionAsync = () => Promise.resolve(void felt.push("selection"));
export const impactAsync = (style: ImpactFeedbackStyle = ImpactFeedbackStyle.Medium) => Promise.resolve(void felt.push(`impact ${style}`));
export const notificationAsync = (type: NotificationFeedbackType = NotificationFeedbackType.Success) => Promise.resolve(void felt.push(type));

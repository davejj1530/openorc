import * as Haptics from "expo-haptics";

/**
 * The app's few haptic moments, so each one feels the same wherever it happens: `select` for a choice in a sheet or a
 * menu, `tap` for something done at once on the phone (a copy, a swipe crossing its threshold, Stop), `confirm` when
 * the Mac accepts what was asked (sent, started, paired), `warn` for a refusal the person can act on, `fail` when it
 * did not happen.
 */
export const haptic = {
  select: () => void Haptics.selectionAsync(),
  tap: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  confirm: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warn: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  fail: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "notification-service",
  name: "NotificationService",
  bundleIdentifier: ".NotificationService",
  deploymentTarget: "16.4",
  // The app's own default group, where expo-secure-store keeps this iPhone's key for each Mac.
  entitlements: { "keychain-access-groups": ["$(AppIdentifierPrefix)app.openorc.mobile"] },
};

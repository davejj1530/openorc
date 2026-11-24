/** The device's speech recognition, which hears nothing here: a test that dictates gives the store its own recognizer. */
export const ExpoSpeechRecognitionModule = {
  getMicrophonePermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
  requestMicrophonePermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
  isRecognitionAvailable: () => false,
  getOnDeviceLocales: async () => [] as string[],
  addListener: () => ({ remove: () => undefined }),
  start: () => undefined,
  stop: () => undefined,
  abort: () => undefined,
};

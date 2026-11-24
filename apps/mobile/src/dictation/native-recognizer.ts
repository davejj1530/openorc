import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type { Recognizer } from "./dictation";
import { pickLanguage } from "./spoken";

/** The module as this app patches it: it also tells which languages the device recognizes by itself. */
const speech = ExpoSpeechRecognitionModule as typeof ExpoSpeechRecognitionModule & { getOnDeviceLocales: () => Promise<string[]> };

/** The module's loudness runs from below 0 for silence to 10; speech at an arm's length sits near 6. */
const LOUDEST = 7;

const deviceLanguage = () => Intl.DateTimeFormat().resolvedOptions().locale;

/** What iOS says when the language's speech model is not on the device after all. */
const NO_MODEL = /initialize recognizer/i;

/**
 * iOS's own speech recognition, held to the device: a recording starts only in a language the device has a model
 * for, and the patched module refuses to start any other way, so no audio goes to a server. On the device it needs
 * only the microphone, so that is all it asks for.
 */
export const nativeRecognizer: Recognizer = {
  async microphone() {
    const held = await speech.getMicrophonePermissionsAsync();
    if (held.granted || !held.canAskAgain) return held.granted;
    return (await speech.requestMicrophonePermissionsAsync()).granted;
  },
  async language() {
    if (!speech.isRecognitionAvailable()) return null;
    return pickLanguage(deviceLanguage(), await speech.getOnDeviceLocales());
  },
  start(language, events) {
    const listening = [
      speech.addListener("start", events.start),
      speech.addListener("result", (event) => events.words(event.results[0]?.transcript ?? "", event.isFinal)),
      speech.addListener("volumechange", (event) => events.level(Math.min(1, Math.max(0, event.value / LOUDEST)))),
      // A device that names a language as its own but holds no model for it fails as the recorder would.
      speech.addListener("error", (event) => events.error(event.error === "audio-capture" && NO_MODEL.test(event.message) ? "service-not-allowed" : event.error)),
      speech.addListener("end", () => {
        listening.forEach((listener) => listener.remove());
        events.end();
      }),
    ];
    speech.start({
      lang: language,
      requiresOnDeviceRecognition: true,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      maxAlternatives: 1,
      iosTaskHint: "dictation",
      volumeChangeEventOptions: { enabled: true, intervalMillis: 50 },
    });
  },
  stop: () => speech.stop(),
  abort: () => speech.abort(),
};

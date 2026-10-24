import { Settings } from "react-native";

/** Epoch ms when the bundle began to run; boot imports this module first. */
const bundleStart = Date.now();
let reported = false;

const samplePush = { type: "frame", frame: { runId: "r1", seq: 1, events: [{ type: "message.delta", runId: "r1", messageId: "m1", role: "assistant", text: "hi", ts: 1, eventId: "e1" }] } };

/**
 * Logs when Home drew its first frame, when the app is launched with
 * `xcrun simctl launch booted app.openorc.mobile -openorcStartupReport 1`. React Native writes console.info to the
 * unified log (subsystem com.facebook.react.log) in Release builds too. The report also times the first zod parse of
 * a frame push, which runs after the measured frame.
 */
export function reportFirstFrame(): void {
  if (reported || !Settings.get("openorcStartupReport")) return;
  reported = true;
  requestAnimationFrame(() => {
    const firstFrame = Date.now();
    void import("@openorc/protocol").then(({ CorePush }) => {
      const started = performance.now();
      const parsed = CorePush.safeParse(samplePush).success;
      const firstParseMs = performance.now() - started;
      console.info(`openorc-startup ${JSON.stringify({ bundleStart, firstFrame, bundleToFrameMs: firstFrame - bundleStart, firstParseMs, parsed })}`);
    });
  });
}

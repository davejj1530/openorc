import { describe, expect, it } from "vitest";
import { simulatorAvcConfig } from "./avc-config";

// Both captured from the hub's iOS stream on a Mac: the low-latency encoder's record, then the fallback encoder's,
// which has no VUI.
const lowLatency = Uint8Array.from([1, 100, 0, 51, 255, 225, 0, 22, 39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20, 158, 106, 154, 129, 1, 1, 3, 194, 1, 8, 248, 1, 0, 4, 40, 238, 60, 176]);
const fallback = Uint8Array.from([1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40, 238, 60, 176]);
const repaired = Uint8Array.from([1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35, 80, 1, 0, 4, 40, 238, 60, 176]);

describe("simulator AVC reorder metadata", () => {
  it("adds zero reordering and one reference frame to the fallback SPS, and leaves a repaired record alone", () => {
    expect(simulatorAvcConfig(fallback)).toEqual(repaired);
    expect(simulatorAvcConfig(repaired)).toBe(repaired);
  });

  it("keeps an SPS that already has VUI and never mutates its input", () => {
    const original = fallback.slice();
    simulatorAvcConfig(fallback);
    expect(fallback).toEqual(original);
    expect(simulatorAvcConfig(lowLatency)).toBe(lowLatency);
  });

  it("repairs every SPS entry and keeps the PPS and profile extensions", () => {
    const extensions = [0xfd, 0xf8, 0xf8, 0];
    const description = Uint8Array.from([...fallback.subarray(0, 5), 0xe2, ...fallback.subarray(6, 20), ...lowLatency.subarray(6, 30), ...fallback.subarray(20), ...extensions]);
    expect(simulatorAvcConfig(description)).toEqual(
      Uint8Array.from([...description.subarray(0, 6), ...repaired.subarray(6, 25), ...lowLatency.subarray(6, 30), ...fallback.subarray(20), ...extensions]),
    );
  });

  it("passes every truncated prefix through untouched", () => {
    for (const config of [fallback, lowLatency]) {
      for (let length = 0; length < config.length; length++) {
        const truncated = config.subarray(0, length);
        expect(simulatorAvcConfig(truncated)).toBe(truncated);
      }
    }
  });

  it("leaves other profiles, scaling lists, bad lengths, bad padding and bad NAL headers alone", () => {
    const variants = [
      [9, 110],
      [12, fallback[12]! | 1],
      [6, 0xff],
      [21, 0xff],
      [19, 0],
      [8, fallback[8]! | 0x80],
    ].map(([index, value]) => {
      const config = fallback.slice();
      config[index!] = value!;
      return config;
    });
    const unterminated = fallback.slice();
    unterminated.fill(0, 12, 20);
    for (const config of [...variants, unterminated]) expect(simulatorAvcConfig(config)).toBe(config);
  });

  it("bounds the record and SPS sizes it parses", () => {
    const oversizedConfig = new Uint8Array(64 * 1024 + 1);
    oversizedConfig.set(fallback);
    expect(simulatorAvcConfig(oversizedConfig)).toBe(oversizedConfig);
    const oversizedSps = new Uint8Array(6 + 2 + 4097 + 7);
    oversizedSps.set(fallback.subarray(0, 6));
    oversizedSps.set([0x10, 1], 6);
    oversizedSps.set(fallback.subarray(8, 20), 8);
    oversizedSps.set(fallback.subarray(20), 8 + 4097);
    expect(simulatorAvcConfig(oversizedSps)).toBe(oversizedSps);
  });
});

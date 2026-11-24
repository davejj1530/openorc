/* global AudioWorkletProcessor, registerProcessor */

/** A tenth of a second at 16 kHz: small enough that words appear as they are spoken, large enough to cost little. */
const BLOCK = 1600;

/** Gathers the microphone's mono samples into blocks and posts each to the page. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    let from = 0;
    while (from < samples.length) {
      const taken = Math.min(samples.length - from, BLOCK - this.filled);
      this.block.set(samples.subarray(from, from + taken), this.filled);
      this.filled += taken;
      from += taken;
      if (this.filled < BLOCK) continue;
      this.port.postMessage(this.block.slice());
      this.filled = 0;
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);

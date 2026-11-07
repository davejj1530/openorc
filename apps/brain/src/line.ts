import type { Readable } from "node:stream";

/** A line that did not arrive whole: too long, cut off, or too slow. */
export class LineError extends Error {}

/**
 * The first line of a stream, without its newline. The stream is left alone after it: nothing more is read, and a
 * stream that ends without a newline gives what it sent. Never repeats what it read in an error.
 */
export function readLine(stream: Readable, { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error: Error | null, line = "") => {
      clearTimeout(timer);
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", failed);
      stream.pause();
      if (error) reject(error);
      else resolve(line);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = bytes.indexOf(0x0a);
      chunks.push(newline === -1 ? bytes : bytes.subarray(0, newline));
      size += newline === -1 ? bytes.length : newline;
      if (size > maxBytes) finish(new LineError(`The line is longer than ${maxBytes} bytes.`));
      else if (newline !== -1) finish(null, Buffer.concat(chunks).toString("utf8"));
    };
    const end = () => (size ? finish(null, Buffer.concat(chunks).toString("utf8")) : finish(new LineError("No line arrived.")));
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new LineError("The line did not arrive in time.")), timeoutMs);
    stream.on("data", data);
    stream.once("end", end);
    stream.once("error", failed);
  });
}

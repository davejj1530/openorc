import { describe, expect, it } from "vitest";
import { MultipartJpegParser, multipartBoundary } from "./mjpeg";

const ascii = (text: string) => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));
// The hub's part layout: boundary, headers with a length, a blank line, the JPEG, a CRLF.
const part = (jpeg: number[]) => join(ascii(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), Uint8Array.from(jpeg), ascii("\r\n"));

describe("multipart boundary", () => {
  it("reads the boundary from the content type the core reports", () => {
    expect(multipartBoundary("multipart/x-mixed-replace; boundary=frame")).toBe("frame");
    expect(multipartBoundary('multipart/x-mixed-replace; boundary="--frame"; charset=x')).toBe("frame");
    expect(multipartBoundary("application/octet-stream")).toBeNull();
    expect(multipartBoundary(undefined)).toBeNull();
  });
});

describe("MultipartJpegParser", () => {
  const first = [0xff, 0xd8, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xd9];
  const second = [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9];
  const body = join(part(first), part(second));

  it("completes each JPEG as soon as its bytes arrive, wherever the body splits", () => {
    for (let split = 0; split <= body.length; split++) {
      const parser = new MultipartJpegParser("frame");
      const parts = [...parser.push(body.subarray(0, split)), ...parser.push(body.subarray(split))];
      expect(parts.map((jpeg) => Array.from(jpeg))).toEqual([first, second]);
    }
  });

  it("ends a part without a length where the next boundary begins", () => {
    const parser = new MultipartJpegParser("frame");
    const parts = parser.push(join(ascii("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), Uint8Array.from(second), ascii("\r\n--frame\r\n")));
    expect(parts.map((jpeg) => Array.from(jpeg))).toEqual([second]);
  });

  it("skips bytes before the first boundary", () => {
    const parser = new MultipartJpegParser("frame");
    expect(parser.push(join(ascii("noise"), part(first))).map((jpeg) => Array.from(jpeg))).toEqual([first]);
  });
});

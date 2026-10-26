/**
 * The iOS MJPEG fallback arrives as a multipart/x-mixed-replace body in arbitrary chunks. The hub writes each part
 * as `--frame`, its headers with a Content-Length, a blank line, the JPEG and a CRLF, so a part is complete as soon
 * as its bytes are in; a part without a length ends where the next boundary begins.
 */

const CRLF_CRLF = Uint8Array.of(13, 10, 13, 10);
/** A part this large means the body lost its framing; the parser starts over at the next boundary. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const ascii = new TextEncoder();
const latin1 = new TextDecoder("latin1");

/** The boundary named by a multipart content type, without its leading dashes. */
export function multipartBoundary(contentType: string | undefined): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  const boundary = match?.[1] ?? match?.[2];
  return boundary ? boundary.replace(/^--/, "") : null;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number, end: number): number {
  const first = needle[0];
  for (let i = from; i <= end - needle.length; i++) {
    if (haystack[i] !== first) continue;
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

type Part = { body: Uint8Array<ArrayBuffer>; next: number };

export class MultipartJpegParser {
  private readonly delimiter: Uint8Array;
  private readonly nextDelimiter: Uint8Array;
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  constructor(boundary: string) {
    this.delimiter = ascii.encode(`--${boundary}`);
    this.nextDelimiter = ascii.encode(`\r\n--${boundary}`);
  }

  /** Every JPEG the new bytes complete, oldest first. */
  push(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
    this.buffer = this.buffer.length === 0 ? bytes.slice() : concat(this.buffer, bytes);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      const part = this.nextPart();
      if (!part) break;
      parts.push(part.body);
      this.buffer = this.buffer.slice(part.next);
    }
    if (this.buffer.length > MAX_BUFFER_BYTES) this.buffer = new Uint8Array(0);
    return parts;
  }

  private nextPart(): Part | null {
    const start = indexOf(this.buffer, this.delimiter, 0, this.buffer.length);
    if (start < 0) return null;
    const headersEnd = indexOf(this.buffer, CRLF_CRLF, start + this.delimiter.length, this.buffer.length);
    if (headersEnd < 0) return null;
    const headers = latin1.decode(this.buffer.subarray(start + this.delimiter.length, headersEnd));
    const bodyStart = headersEnd + CRLF_CRLF.length;
    const length = /content-length:\s*(\d+)/i.exec(headers)?.[1];
    if (length !== undefined) {
      const bodyEnd = bodyStart + Number(length);
      return bodyEnd <= this.buffer.length ? { body: this.buffer.slice(bodyStart, bodyEnd), next: bodyEnd } : null;
    }
    const bodyEnd = indexOf(this.buffer, this.nextDelimiter, bodyStart, this.buffer.length);
    return bodyEnd < 0 ? null : { body: this.buffer.slice(bodyStart, bodyEnd), next: bodyEnd + 2 };
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

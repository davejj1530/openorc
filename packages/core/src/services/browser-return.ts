/**
 * How a browser comes back to an app with no deep links: a listener on loopback, for one GET of a path, as the reviewer
 * app's setup listens. The server sends the browser here with its own state in the query, and checks that state when
 * the app posts the query back with its token, so the query is passed on unread and holds nothing without the token.
 *
 *   one request to `path`   answered with a page that says to go back to OpenOrc; `query` resolves; the listener closes
 *   any other path          404, still listening
 *   `timeoutMs` passes      `query` rejects with words to try again; the listener closes
 *   close()                 `query` rejects with an empty message, a cancel; the listener closes
 *
 * Bound to 127.0.0.1 only, on a port the system picks.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface BrowserReturn {
  port: number;
  /** The query string the browser came back with, without its "?". */
  query: Promise<string>;
  close(): void;
}

const TIMED_OUT = "The browser didn't come back in time. Try again.";
const PAGE = '<!doctype html><meta charset=utf-8><title>OpenOrc</title><p style="font:15px system-ui;margin:3em">You can return to OpenOrc. You can close this tab.</p>';

export async function awaitBrowserReturn(path: string, timeoutMs: number): Promise<BrowserReturn> {
  let resolve!: (query: string) => void;
  let reject!: (error: Error) => void;
  const query = new Promise<string>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  // A caller that stops waiting (a cancel) must not leave an unhandled rejection behind.
  query.catch(() => undefined);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== path) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }).end(PAGE, () => finish(() => resolve(url.search.replace(/^\?/, ""))));
  });
  const timer = setTimeout(() => finish(() => reject(new Error(TIMED_OUT))), timeoutMs);
  timer.unref();
  let done = false;
  function finish(then: () => void): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    then();
  }
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => listening());
  });
  return { port: (server.address() as AddressInfo).port, query, close: () => finish(() => reject(new Error(""))) };
}

/**
 * How a browser comes back to an app with no deep links: a listener on loopback, for one GET of a path, as the reviewer
 * app's setup listens. The server sends the browser here with its own state in the query, and checks that state when
 * the app posts the query back with its token, so the query is passed on unread and holds nothing without the token.
 *
 *   one request to `path`   resolves `query`; answers now, or waits for `redirect` when `waitForResult` is set
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
  /** Finishes a held response with the server's result page, once the app knows the outcome. */
  redirect(url: string): void;
  close(): void;
}

const TIMED_OUT = "The browser didn't come back in time. Try again.";
const PAGE = '<!doctype html><meta charset=utf-8><title>OpenOrc</title><p style="font:15px system-ui;margin:3em">You can return to OpenOrc. You can close this tab.</p>';

export async function awaitBrowserReturn(path: string, timeoutMs: number, waitForResult = false): Promise<BrowserReturn> {
  let resolve!: (query: string) => void;
  let reject!: (error: Error) => void;
  const query = new Promise<string>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  // A caller that stops waiting (a cancel) must not leave an unhandled rejection behind.
  query.catch(() => undefined);
  let held: http.ServerResponse | null = null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== path) return void response.writeHead(404).end();
    if (held) return void response.writeHead(410).end();
    if (waitForResult) {
      held = response;
      resolve(url.search.replace(/^\?/, ""));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }).end(PAGE, () => finish(() => resolve(url.search.replace(/^\?/, ""))));
  });
  const timer = setTimeout(() => finish(() => reject(new Error(TIMED_OUT))), timeoutMs);
  timer.unref();
  let done = false;
  function finish(then: () => void): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (held && !held.writableEnded) held.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Sign-in could not finish. Start again from OpenOrc.");
    server.close();
    server.closeIdleConnections();
    then();
  }
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => listening());
  });
  return {
    port: (server.address() as AddressInfo).port,
    query,
    redirect: (url) => {
      if (done) return;
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("The sign-in result page must be a web address.");
      held?.writeHead(303, { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" }).end();
      finish(() => reject(new Error("")));
    },
    close: () => finish(() => reject(new Error(""))),
  };
}

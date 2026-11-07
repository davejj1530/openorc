import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { InstancePort } from "./instance-port.js";

let server: http.Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
});

it("asks again on a fresh connection when a kept-open one closes just as it is reused", async () => {
  const answered = new WeakSet<Socket>();
  server = http.createServer((request, response) => {
    if (answered.has(request.socket)) return void request.socket.destroy();
    answered.add(request.socket);
    request.resume();
    request.on("end", () => response.end(request.method === "PUT" ? "" : "contents"));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = new InstancePort({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers: {} });

  expect((await port.getFile("/a"))?.toString("utf8")).toBe("contents");
  expect((await port.getFile("/a"))?.toString("utf8")).toBe("contents");
  await port.putFile("/b", Buffer.from("x"));
});

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpeechModel, SpeechModelState } from "../shared/dictation";
import { SpeechModels, type FetchModel } from "./speech-models";

const bytes = Buffer.from("a speech model, as far as this test is concerned");
const model: SpeechModel = {
  id: "example",
  name: "Example",
  languages: "English",
  credit: "Example, MIT",
  file: "example.gguf",
  url: "https://example.com/example.gguf",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store in a folder of its own, served by `serve`, with every state it reported and a wait for the download to end. */
function store(serve: (range: string | undefined) => Response) {
  const dir = mkdtempSync(join(tmpdir(), "speech-models-"));
  dirs.push(dir);
  const states: SpeechModelState[] = [];
  const asked: (string | undefined)[] = [];
  const fetch: FetchModel = async (_url, init) => {
    asked.push(init.headers["Range"]);
    return serve(init.headers["Range"]);
  };
  const models = new SpeechModels(dir, fetch, (_id, state) => states.push(state));
  const ended = async () => {
    while (states.at(-1)?.phase === "downloading" || states.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    return states.at(-1)!;
  };
  return { dir, models, asked, ended };
}

describe("SpeechModels", () => {
  it("keeps a download whose bytes match the model", async () => {
    const { models, ended } = store(() => new Response(bytes));
    expect(models.state(model)).toEqual({ phase: "missing" });
    models.download(model);
    expect(await ended()).toEqual({ phase: "ready" });
    expect(readFileSync(models.file(model))).toEqual(bytes);
  });

  it("refuses bytes that are not the model, and leaves nothing behind", async () => {
    const { models, ended, dir } = store(() => new Response(Buffer.from(bytes).fill(0)));
    models.download(model);
    expect(await ended()).toEqual({ phase: "failed", reason: "The download did not match the speech model." });
    expect(() => readFileSync(join(dir, "example.gguf.part"))).toThrow();
  });

  it("continues what an interrupted download left", async () => {
    const { models, ended, asked, dir } = store((range) => (range ? new Response(bytes.subarray(10), { status: 206 }) : new Response(bytes)));
    writeFileSync(join(dir, "example.gguf.part"), bytes.subarray(0, 10));
    models.download(model);
    expect(await ended()).toEqual({ phase: "ready" });
    expect(asked).toEqual(["bytes=10-"]);
    expect(readFileSync(models.file(model))).toEqual(bytes);
  });

  it("starts over when the server sends the whole file instead of the rest", async () => {
    const { models, ended, dir } = store(() => new Response(bytes));
    writeFileSync(join(dir, "example.gguf.part"), bytes.subarray(0, 10));
    models.download(model);
    expect(await ended()).toEqual({ phase: "ready" });
    expect(readFileSync(models.file(model))).toEqual(bytes);
  });

  it("says why the server refused", async () => {
    const { models, ended } = store(() => new Response(null, { status: 404 }));
    models.download(model);
    expect(await ended()).toEqual({ phase: "failed", reason: "The download answered 404." });
  });
});

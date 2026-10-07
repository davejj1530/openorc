import * as prettier from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as graphql from "prettier/plugins/graphql";
import * as html from "prettier/plugins/html";
import * as markdown from "prettier/plugins/markdown";
import * as postcss from "prettier/plugins/postcss";
import * as typescript from "prettier/plugins/typescript";
import * as yaml from "prettier/plugins/yaml";

/** One format for the bundled Prettier, and its answer. */
export type FormatRequest = { id: number; text: string; filepath: string };
export type FormatReply = { id: number; text: string } | { id: number; error: string };

/** The end of a worker's message channel serveFormatter listens and answers on. */
export interface FormatPort {
  on(event: "message", listener: (request: FormatRequest) => void): unknown;
  postMessage(reply: FormatReply): void;
}

const plugins = [babel, estree, typescript, postcss, html, markdown, yaml, graphql];

/** Prettier's standalone build, for the languages the bundled fallback formats. `endOfLine: "auto"` keeps a CRLF file CRLF. */
function formatWithPrettier(text: string, filepath: string): Promise<string> {
  return prettier.format(text, { filepath, plugins, endOfLine: "auto" });
}

/**
 * Formats for a worker thread with the Prettier that ships with the app. Only this module and Prettier load in the
 * worker. It never reads a project's config, since a JavaScript config would run the project's code inside the app.
 */
export function serveFormatter(port: FormatPort, format: (text: string, filepath: string) => Promise<string> = formatWithPrettier): void {
  port.on("message", ({ id, text, filepath }) => {
    format(text, filepath).then(
      (formatted) => port.postMessage({ id, text: formatted }),
      (error: unknown) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

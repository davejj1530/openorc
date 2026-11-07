import type { EditorResult } from "@openorc/protocol";
import { TypeScriptIntelligence, type IntelligenceRequest } from "./typescript-intelligence.js";

export type IntelligenceMessage = { id: number; request: IntelligenceRequest };
export type IntelligenceReply = { id: number; result: EditorResult } | { id: number; error: string };

interface IntelligencePort {
  on(event: "message", listener: (message: IntelligenceMessage) => void): unknown;
  postMessage(message: IntelligenceReply): void;
}

export function serveIntelligence(port: IntelligencePort): void {
  const engine = new TypeScriptIntelligence();
  port.on("message", ({ id, request }) => {
    try {
      port.postMessage({ id, result: engine.query(request) });
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

import { z } from "zod";

export const Visualization = z.object({
  title: z.string().trim().min(1).max(120).describe("A short title for the concept being explained."),
  description: z.string().trim().min(1).max(2000).describe("A plain-text explanation of what the visual shows, also available when it cannot render."),
  html: z.string().trim().min(1).max(256_000).describe("A self-contained HTML fragment with inline CSS, SVG and optional JavaScript. No external assets or libraries."),
});
export type Visualization = z.infer<typeof Visualization>;

/** OpenOrc's tool names as reported by Codex, Claude Code and OpenCode. */
export function isVisualizationTool(name: string): boolean {
  return /^(?:mcp__openorc(?:_[0-9a-f]{32})?__|openorc(?:_[0-9a-f]{32})?\.|openorc_[0-9a-f]{32}_)visualize$/.test(name);
}

export const visualizationInstructions =
  "Use OpenOrc's visualize tool when a diagram, chart, or small interactive explanation would help the user understand a concept. It renders inline in the conversation and stays available in history. Use it selectively; short answers usually need only text. Supply a concise title, a plain-text description, and a self-contained HTML fragment. Use inline SVG for diagrams and charts, and inline JavaScript for local controls or step-throughs. External libraries, network requests, file access and agent tool calls are unavailable. The host provides theme-aware CSS variables --background, --foreground, --muted, --border, --accent and --surface, plus basic native control styles. Keep the layout responsive down to 320px, label controls and visual elements, respect reduced motion, and include a useful initial state. Keep the explanation in the conversation; do not repeat the HTML in your reply.";

export const VisualizationFrameMessage = z.discriminatedUnion("method", [
  z.object({ jsonrpc: z.literal("2.0"), method: z.literal("ui/notifications/sandbox-proxy-ready") }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.literal("ui/notifications/initialized") }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.literal("ui/notifications/size-changed"), params: z.object({ height: z.number().finite() }) }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.literal("openorc/visualization-error"), params: z.object({ message: z.string().max(500) }) }),
]);

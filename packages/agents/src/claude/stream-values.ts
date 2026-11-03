export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function contentText(content: unknown): string {
  return (
    str(content) ??
    (Array.isArray(content)
      ? content
          .filter(isRecord)
          .filter((block) => block["type"] === "text")
          .map((block) => str(block["text"]) ?? "")
          .join("\n")
      : "")
  );
}

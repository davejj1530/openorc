/**
 * Secret redaction for what OpenOrc stores. It is a best-effort filter for the
 * well-known token shapes, credentials in URLs and headers, and values assigned
 * to secret-named variables or fields. It cannot recognize every sensitive
 * value. Structured values are redacted field by field before serialization,
 * so escapes and neighbouring strings never hide or merge a match.
 */
interface Rule {
  id: string;
  /** A capture group, when present, holds the secret and ends the match; otherwise the whole match is the secret. */
  pattern: RegExp;
}

/** Variable and field names whose values are secrets, alone or as a suffix such as DB_PASSWORD or PGPASSWORD. */
const SECRET_NAME = String.raw`[a-z0-9_-]*?(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|authorization)`;
/** Where an unquoted value ends. A value followed by `(` or `[` is code, not a secret. */
const VALUE_END = String.raw`(?=[\s"'\`,;)\]}>]|$)`;
/** Unquoted code that names a value instead of holding one, such as `config.apiKey` or `process.env.TOKEN`. */
const MEMBER_PATH = String.raw`[A-Za-z_]\w*(?:\??\.[A-Za-z_]\w*)+!?`;

const rules: Rule[] = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Key material cut off before its end line, as in truncated output or a streamed fragment.
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/]{16}[\s\S]*$/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: "slack-token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
  { id: "slack-app-token", pattern: /\bxapp-[A-Za-z0-9-]{10,}/g },
  { id: "openorc-device-key", pattern: /\boqd_[a-f0-9]{64}\b/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { id: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // A credential, not a challenge parameter such as `Bearer resource_metadata="…"`.
  { id: "authorization-header", pattern: /\b(?:Bearer|Basic)\s+([\w.~+/-]{16,}=*)(?![\w.~+/=-]|(?<==)\\*["'])/gi },
  { id: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)(?=@)/gi },
  {
    id: "secret-assignment",
    pattern: new RegExp(String.raw`\b${SECRET_NAME}\\?["']?\s*[=:]\s*(?:\\?"([^"\\\n]{8,})|\\?'([^'\\\n]{8,})|(?!${MEMBER_PATH}${VALUE_END})([^\s"'\`,;(){}\[\]<>$%\\]{8,})${VALUE_END})`, "gi"),
  },
];

/** A field whose name marks its whole string value as a secret. */
const secretField = new RegExp(`^(?:${SECRET_NAME}|cookie|set-cookie)$`, "i");
const SECRET_FIELD = "secret-field";

export interface RedactResult {
  text: string;
  redacted: boolean;
  rules: string[];
}

export function redact(text: string): RedactResult {
  let out = text;
  const hit = new Set<string>();
  for (const rule of rules) {
    out = out.replace(rule.pattern, (match: string, ...args: unknown[]) => {
      if (match.includes("[redacted:")) return match;
      hit.add(rule.id);
      // The last two arguments are the match offset and the whole input, not captures.
      const secret = args.slice(0, -2).find((arg): arg is string => typeof arg === "string");
      return `${secret ? match.slice(0, -secret.length) : ""}[redacted:${rule.id}]`;
    });
  }
  return { text: out, redacted: hit.size > 0, rules: [...hit] };
}

export interface RedactValueResult<T> {
  value: T;
  redacted: boolean;
  rules: string[];
}

/**
 * Redacts every string inside a JSON-compatible value, and replaces the whole
 * string of any field with a secret name, such as `password` or `DB_PASSWORD`.
 * Returns the input itself when nothing matched.
 */
export function redactValue<T>(value: T): RedactValueResult<T> {
  const hit = new Set<string>();
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === "string") {
      if (key !== null && node.length > 0 && secretField.test(key) && !node.startsWith("[redacted:")) {
        hit.add(SECRET_FIELD);
        return `[redacted:${SECRET_FIELD}]`;
      }
      const result = redact(node);
      for (const rule of result.rules) hit.add(rule);
      return result.redacted ? result.text : node;
    }
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((item) => {
        const out = walk(item, null);
        if (out !== item) changed = true;
        return out;
      });
      return changed ? next : node;
    }
    if (node !== null && typeof node === "object") {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [field, item] of Object.entries(node)) {
        const out = walk(item, field);
        if (out !== item) changed = true;
        next[field] = out;
      }
      return changed ? next : node;
    }
    return node;
  };
  const out = walk(value, null) as T;
  return { value: out, redacted: hit.size > 0, rules: [...hit] };
}

/** `JSON.stringify` of the redacted value. */
export function redactJson(value: unknown, space?: number): string {
  return JSON.stringify(redactValue(value).value, null, space);
}

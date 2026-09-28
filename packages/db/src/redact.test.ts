import { describe, expect, it } from "vitest";
import { redact, redactJson, redactValue } from "./redact.js";

describe("redact", () => {
  it("catches the usual token shapes", () => {
    const cases: [string, string][] = [
      ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12", "github-token"],
      ["glpat-abcdefghij0123456789", "gitlab-token"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
      ["xoxb-123456789012-abcdefghij", "slack-token"],
      ["xapp-1-1234567890-abcdefghij", "slack-app-token"],
      [`oqd_${"a".repeat(64)}`, "openorc-device-key"],
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "anthropic-key"],
      ["sk-svcacct-abcdefghijklmnopqrstuvwxyz", "openai-key"],
      ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm-token"],
      ["hf_abcdefghijklmnopqrstuvwxyz0123456", "huggingface-token"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
    ];
    for (const [input, rule] of cases) {
      const r = redact(`before ${input} after`);
      expect(r.rules, input).toEqual([rule]);
      expect(r.text).toBe(`before [redacted:${rule}] after`);
    }
  });

  it("finds a token at the start of a line", () => {
    expect(redact("token:\nghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12\n").text).toBe("token:\n[redacted:github-token]\n");
  });

  it("redacts only the secret of an assignment, header, or URL", () => {
    const cases: [string, string][] = [
      ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[redacted:secret-assignment]"],
      ["PGPASSWORD=s3cr3t!pass", "PGPASSWORD=[redacted:secret-assignment]"],
      ['password: "correct horse battery"', 'password: "[redacted:secret-assignment]"'],
      ['{"client_secret":"abcd1234efgh"}', '{"client_secret":"[redacted:secret-assignment]"}'],
      ['{\\"api_key\\":\\"abcd1234efgh\\"}', '{\\"api_key\\":\\"[redacted:secret-assignment]\\"}'],
      ["X-Api-Key: 1234567890abcdef", "X-Api-Key: [redacted:secret-assignment]"],
      ["//registry.npmjs.org/:_authToken=abcdef123456", "//registry.npmjs.org/:_authToken=[redacted:secret-assignment]"],
      ["mysql --password=hunter2hunter2 -u root", "mysql --password=[redacted:secret-assignment] -u root"],
      ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer [redacted:authorization-header]"],
      ["Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "Authorization: Basic [redacted:authorization-header]"],
      ['{"Authorization":"Basic dXNlcjpwYXNzd29yZDEyMw=="}', '{"Authorization":"[redacted:secret-assignment]"}'],
      ["postgres://admin:user@db.internal:5432/app", "postgres://admin:[redacted:url-credentials]@db.internal:5432/app"],
    ];
    for (const [input, expected] of cases) expect(redact(input).text, input).toBe(expected);
  });

  it("redacts private keys, including one cut off before its end line", () => {
    const body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw";
    expect(redact(`key:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\ndone`).text).toBe("key:\n[redacted:private-key]\ndone");
    expect(redact(`key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`).text).toBe("key:\n[redacted:private-key]");
  });

  it("leaves code that names a secret without holding one", () => {
    for (const code of [
      "const x = rows.map((r) => r.value * 3).join(',');",
      "apiKey: process.env.OPENAI_API_KEY,",
      "password: form?.password",
      "const password = hashPassword(input);",
      'api_key = os.environ["OPENAI_API_KEY"]',
      "password: ${DB_PASSWORD}",
      "password: <your-password>",
      "password?: string;",
      'if (pem.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {',
      'www_authenticate_header: "Bearer resource_metadata=\\"https://mcp.example.com/.well-known/oauth-protected-resource\\",scope=\\"mcp:connect\\""',
      'WWW-Authenticate: Bearer realm="example", error="invalid_token"',
      String.raw`{\"www_authenticate_header\": \"Bearer resource_metadata=\\\"https://mcp.example.com/.well-known/oauth-protected-resource\\\"\"}`,
    ])
      expect(redact(code), code).toEqual({ text: code, redacted: false, rules: [] });
  });

  it("does not redact its own markers again", () => {
    const once = redact("API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz").text;
    expect(once).toBe("API_KEY=[redacted:anthropic-key]");
    expect(redact(once)).toEqual({ text: once, redacted: false, rules: [] });
  });
});

describe("redactValue", () => {
  it("redacts every string and the whole value of secret-named fields", () => {
    const result = redactValue({
      type: "tool.started",
      input: { headers: { Authorization: "token abc", "X-Trace": "1" }, password: "x", nested: ["DB_PASSWORD=hunter2hunter2", 3] },
      hasApiKey: true,
    });
    expect(result.value).toEqual({
      type: "tool.started",
      input: { headers: { Authorization: "[redacted:secret-field]", "X-Trace": "1" }, password: "[redacted:secret-field]", nested: ["DB_PASSWORD=[redacted:secret-assignment]", 3] },
      hasApiKey: true,
    });
    expect(result.rules.sort()).toEqual(["secret-assignment", "secret-field"]);
  });

  it("returns the input itself when nothing matched", () => {
    const value = { a: "plain", b: [1, "text", { c: null }] };
    expect(redactValue(value)).toEqual({ value, redacted: false, rules: [] });
    expect(redactValue(value).value).toBe(value);
  });

  it("never matches across two strings of the serialized value", () => {
    const value = { a: "-----BEGIN RSA PRIVATE KEY-----", b: "kept", c: "-----END RSA PRIVATE KEY-----" };
    expect(JSON.parse(redactJson(value))).toEqual(value);
  });
});

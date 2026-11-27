// Redaction of the history store (#25). Pure; runs on every Node, with or without node:sqlite.
// Every secret below is invented and assembled at run time from pieces, so this file itself
// holds no string that looks like a real key.
import { describe, expect, it } from "vitest";
import {
  HISTORY_REDACTION_RULES,
  prepareHistoryLine,
  redactJsonValue,
  redactText,
  redactionMarker,
} from "../../src/sources/node.js";
import { FAKE } from "./secrets.js";

describe("redactText", () => {
  it.each(Object.entries(FAKE.tokens))("replaces a %s token", (_name, token) => {
    const result = redactText(`before ${token} after`);
    expect(result.text).not.toContain(token);
    expect(result.text).toMatch(/^before \[redacted:[a-z0-9-]+\] after$/);
    expect(result.count).toBe(1);
  });

  it("replaces a whole private key block, and an unterminated one to the end", () => {
    const block = FAKE.privateKey;
    const result = redactText(`key:\n${block}\nend`);
    expect(result.text).toBe(`key:\n${redactionMarker("private-key")}\nend`);
    const cut = redactText(`start ${FAKE.privateKeyHead} ${FAKE.keyBody} more`);
    expect(cut.text).toBe(`start ${redactionMarker("private-key")}`);
  });

  it("replaces the user and password of a URL and keeps the host", () => {
    const result = redactText(`connect ${FAKE.urlWithCredentials} now`);
    expect(result.text).not.toContain(FAKE.urlPassword);
    expect(result.text).not.toContain("example-user");
    expect(result.text).toContain(
      `postgres://${redactionMarker("url-credentials")}@db.example.com/app`,
    );
  });

  it("replaces authorization header values and keeps the scheme", () => {
    const result = redactText(`Authorization: Bearer ${FAKE.bearer}`);
    expect(result.text).toBe(`Authorization: Bearer ${redactionMarker("authorization")}`);
    const basic = redactText(`curl -H "Authorization: Basic ${FAKE.basic}" x`);
    expect(basic.text).not.toContain(FAKE.basic);
    const loose = redactText(`use bearer ${FAKE.bearer} here`);
    expect(loose.text).toBe(`use bearer ${redactionMarker("auth-scheme")} here`);
  });

  it("does not treat ordinary words after Bearer or Basic as credentials", () => {
    expect(redactText("basic understanding of the bearer bonds").count).toBe(0);
  });

  it("replaces password, secret, token and key assignments in several forms", () => {
    const cases = [
      `DB_PASSWORD=${FAKE.password}`,
      `export SERVICE_SECRET="${FAKE.password}"`,
      `{"api_key": "${FAKE.password}"}`,
      `password: ${FAKE.password}`,
      `client_secret='${FAKE.password}'`,
      `access_token=${FAKE.password}&next=1`,
      // A short part after the secret word, and camelCase names.
      `DB_PASSWORD_PROD=${FAKE.password}`,
      `SECRET_KEY_BASE=${FAKE.password}`,
      `GITHUB_TOKEN_RW=${FAKE.password}`,
      `API_KEY_ID=${FAKE.password}`,
      `password_confirmation: ${FAKE.password}`,
      `{"accessToken": "${FAKE.password}"}`,
      `dbPassword=${FAKE.password}`,
    ];
    const results = cases.map((text) => {
      const result = redactText(text);
      return {
        text,
        leaked: result.text.includes(FAKE.password),
        marked: result.text.includes(redactionMarker("assignment")),
        count: result.count,
      };
    });
    expect(results).toEqual(cases.map((text) => ({ text, leaked: false, marked: true, count: 1 })));
  });

  it("replaces Cookie and Set-Cookie header values", () => {
    const cookie = redactText(`Cookie: sid=${FAKE.password}; theme=dark`);
    expect(cookie.text).toBe(`Cookie: ${redactionMarker("cookie")}`);
    const quoted = redactText(`curl -H "set-cookie: sid=${FAKE.password}" x`);
    expect(quoted.text).toBe(`curl -H "set-cookie: ${redactionMarker("cookie")}" x`);
    expect(quoted.count).toBe(1);
  });

  it("leaves text without secrets alone and counts nothing", () => {
    const text = "Read src/widget.ts and ran the example-project tests: 3 passed, max_tokens: 1000";
    expect(redactText(text)).toEqual({ text, count: 0 });
    // A plain lower-case ending after the word is not a qualifier.
    for (const other of ['"input_tokens": 12', "tokens: 12", "tokenizer: x123"]) {
      expect(redactText(other)).toEqual({ text: other, count: 0 });
    }
  });

  it("documents every rule with an id and a description", () => {
    const ids = HISTORY_REDACTION_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of HISTORY_REDACTION_RULES) expect(rule.description.length).toBeGreaterThan(10);
  });
});

describe("redactJsonValue", () => {
  it("walks nested strings and keys, keeps numbers, booleans and null, and does not change the input", () => {
    const input = {
      type: "assistant",
      message: {
        usage: { input_tokens: 12, output_tokens: 3 },
        content: [
          { type: "text", text: `here is ${FAKE.tokens.github}` },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: `DB_PASSWORD=${FAKE.password} run` },
          },
        ],
      },
      flag: true,
      nothing: null,
    };
    const copy = structuredClone(input);
    const result = redactJsonValue(input);
    expect(input).toEqual(copy);
    const text = JSON.stringify(result.value);
    expect(text).not.toContain(FAKE.tokens.github);
    expect(text).not.toContain(FAKE.password);
    expect(result.count).toBe(2);
    const value = result.value as typeof input;
    expect(value.message.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(value.flag).toBe(true);
    expect(value.nothing).toBeNull();
  });

  it("replaces a string under a key that names a secret, whatever it holds", () => {
    const result = redactJsonValue({
      password: "plain-words",
      nested: { apiKey: "x1", token: "" },
    });
    expect(result.value).toEqual({
      password: redactionMarker("key"),
      nested: { apiKey: redactionMarker("key"), token: "" },
    });
    expect(result.count).toBe(2);
  });

  it("replaces strings under camelCase and qualified secret keys", () => {
    const keys = [
      "accessToken",
      "refreshToken",
      "sessionToken",
      "idToken",
      "githubToken",
      "authToken",
      "dbPassword",
      "secretKeyBase",
      "SECRET_KEY_BASE",
      "DB_PASSWORD_PROD",
      "apiKeyId",
      "x-api-key",
      "proxyAuthorization",
      "Cookie",
      "set-cookie",
    ];
    const result = redactJsonValue(Object.fromEntries(keys.map((key) => [key, FAKE.password])));
    expect(JSON.stringify(result.value)).not.toContain(FAKE.password);
    expect(result.value).toEqual(
      Object.fromEntries(keys.map((key) => [key, redactionMarker("key")])),
    );
    expect(result.count).toBe(keys.length);
  });

  it("keeps strings under keys where the word is not at the end of a name part", () => {
    const value = { tokenizer: "example-tokenizer", tokens: "many", stop_reason: "end_turn" };
    expect(redactJsonValue(value)).toEqual({ value, count: 0 });
  });

  it("keeps a __proto__ key as an own property", () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"x": 1}, "a": 2}');
    const result = redactJsonValue(parsed);
    expect(Object.keys(result.value as object)).toEqual(["__proto__", "a"]);
  });
});

describe("prepareHistoryLine", () => {
  it("keys a line by its uuid, and other lines by a hash of the redacted text", () => {
    const withUuid = prepareHistoryLine(JSON.stringify({ type: "user", uuid: "u-example-1" }));
    expect(withUuid).toMatchObject({ kind: "store", baseKey: "u:u-example-1" });
    const withoutUuid = prepareHistoryLine(JSON.stringify({ type: "mode", mode: "default" }));
    expect(withoutUuid).toMatchObject({
      kind: "store",
      baseKey: expect.stringMatching(/^h:[0-9a-f]{32}$/) as unknown as string,
    });
  });

  it("stores the redacted JSON", () => {
    const prepared = prepareHistoryLine(
      JSON.stringify({ type: "user", message: { content: `token=${FAKE.password}` } }),
    );
    expect(prepared.kind).toBe("store");
    if (prepared.kind !== "store") return;
    expect(prepared.text).not.toContain(FAKE.password);
    expect(prepared.redactions).toBe(1);
    expect(JSON.parse(prepared.text)).toEqual({
      type: "user",
      message: { content: `token=${redactionMarker("assignment")}` },
    });
  });

  it("stores a line that is not JSON only when no rule matches it", () => {
    const clean = prepareHistoryLine('{"type":"assistant","message":{"id":"msg_cut"');
    expect(clean).toMatchObject({
      kind: "store",
      text: '{"type":"assistant","message":{"id":"msg_cut"',
    });
    expect(prepareHistoryLine(`{"type":"user","text":"${FAKE.tokens.anthropic}`)).toEqual({
      kind: "skip",
    });
  });
});

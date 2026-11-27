/**
 * Redaction before anything reaches the history store (ticket #25). Best effort.
 *
 * Each transcript line is parsed and walked; every string value (and every object key) is passed
 * through the rules below, and a string under a key that ends in a secret word (`password`,
 * `apiKey`, `accessToken`, `SECRET_KEY_BASE` and so on) is replaced whole. A line that cannot be parsed is checked as text by the
 * same rules; the ingest stores it only when no rule matched (see `ingest.ts`).
 *
 * What it does not catch, listed in docs/privacy.md: secrets without a known prefix or a
 * telling key name (a random string in a prompt, a password typed on its own), secrets split
 * across strings or lines, encoded secrets (base64 of a key file, URL-encoded values), values
 * passed as a separate command-line argument (`--password x`), names where the secret word is not
 * at the end or is followed by more than two short parts, and personal data in general
 * (names, emails, paths, file contents). The store is therefore as sensitive as the transcripts.
 *
 * Every pattern is written so that its source text does not contain the strings it detects, so
 * this file passes `npm run privacy`. Uses ES2022 only.
 */

/** One rule: an id for counts and docs, a description, and how it rewrites a string. */
export interface RedactionRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

/** Text a redacted value is replaced with. `<id>` is the rule id. */
export function redactionMarker(id: string): string {
  return `[redacted:${id}]`;
}

const MARKER_PREFIX = "[redacted:";

/** Prefixed token formats. The whole match is replaced. */
const TOKEN_RULES: readonly RedactionRule[] = [
  {
    id: "private-key",
    description: "PEM private key blocks (BEGIN ... PRIVATE KEY to END, or to the end of the text)",
    pattern:
      /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}[\s\S]*?(?:-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}|$)/g,
  },
  {
    id: "anthropic",
    description: "Anthropic API keys (sk-ant- prefix)",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: "openai",
    description: "OpenAI-style secret keys (sk-, sk-proj-, sk-svcacct-, sk-admin- prefixes)",
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "github",
    description: "GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_ prefixes)",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  {
    id: "gitlab",
    description: "GitLab personal access tokens (glpat- prefix)",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "aws",
    description: "AWS access key ids (AKIA, ASIA prefixes)",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "slack",
    description: "Slack tokens (xoxa-, xoxb-, xoxp-, xoxo-, xoxr-, xoxs- prefixes)",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "google",
    description: "Google API keys (AIza prefix)",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  {
    id: "stripe",
    description: "Stripe keys (sk_, rk_, pk_ with live_ or test_)",
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  {
    id: "digitalocean",
    description: "DigitalOcean tokens (do?_v1_ prefixes)",
    pattern: /\bdo[opr]_v1_[A-Za-z0-9]{16,}/g,
  },
  {
    id: "npm",
    description: "npm tokens (npm_ prefix)",
    pattern: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  },
  {
    id: "huggingface",
    description: "Hugging Face tokens (hf_ prefix)",
    pattern: /\bhf_[A-Za-z0-9]{30,}/g,
  },
  {
    id: "jwt",
    description: "JSON Web Tokens (three base64url parts, the first two starting eyJ)",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
];

/** `scheme://user:password@` in a URL. The user and password are replaced. */
const URL_CREDENTIALS: RedactionRule = {
  id: "url-credentials",
  description: "user name and password in a URL (scheme://user:password@host)",
  pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/?#@:"'<>]+:[^\s/?#@"'<>]+@/gi,
};

/** `Authorization: <scheme> <value>` headers. The value is replaced, the scheme kept. */
const AUTH_HEADER: RedactionRule = {
  id: "authorization",
  description: "Authorization and Proxy-Authorization header values",
  pattern:
    /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest|negotiate)\s+)?[^\s"',;]+/gi,
};

/** `Bearer <token>` or `Basic <credentials>` anywhere, when the value has a digit. */
const AUTH_SCHEME: RedactionRule = {
  id: "auth-scheme",
  description: "Bearer and Basic credentials (a value of 8 or more characters with a digit)",
  pattern: /\b(bearer|basic)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/-]{8,}=*/gi,
};

/**
 * A regular expression source that matches `source` in any letter case. Letters inside a
 * character class are left alone, so `source` may only use classes without letters (`[_-]`).
 * Used instead of the `i` flag so the qualifier below can still tell lower from upper case.
 */
function anyCase(source: string): string {
  let out = "";
  let inClass = false;
  for (const char of source) {
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    out += !inClass && /[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char;
  }
  return out;
}

/** Words that name a secret, in any case, used in assignments and object keys. */
const SECRET_WORD = anyCase(
  "password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?",
);

/**
 * Up to two short parts after the secret word: each starts with `_`, `.` or `-`
 * (`DB_PASSWORD_PROD`, `SECRET_KEY_BASE`, `password_confirmation`) or is a camelCase part, an
 * upper-case letter right after a lower-case one (`passwordHash`, `secretKeyBase`). A plain
 * lower-case ending is not a part, so `tokens`, `max_tokens` and `tokenizer` do not match.
 */
const QUALIFIER = "(?:[_.-][A-Za-z0-9]{1,12}|(?<=[a-z0-9])[A-Z][A-Za-z0-9]{0,11}){0,2}";

/**
 * `name = value` or `name: value` where the name ends in a secret word, optionally followed by a
 * qualifier. The value is replaced.
 */
const ASSIGNMENT: RedactionRule = {
  id: "assignment",
  description:
    "assignments whose name ends in password, secret, token, API key or a similar word, optionally followed by up to two short parts (name=value, name: value, quoted or not)",
  pattern: new RegExp(
    `\\b([A-Za-z0-9_.-]*?(?:${SECRET_WORD})${QUALIFIER})(["']?\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;&}\\]]+)`,
    "g",
  ),
};

/** `Cookie:` and `Set-Cookie:` header values. The value is replaced, to the end of the line. */
const COOKIE_HEADER: RedactionRule = {
  id: "cookie",
  description: "Cookie and Set-Cookie header values (to the end of the line or a quote)",
  pattern: /\b((?:set-)?cookie)(["']?\s*:\s*["']?)([^\r\n"']+)/gi,
};

/**
 * An object key whose string value is replaced whole: a key that ends in a secret word,
 * `authorization` or `cookie`, after any characters (so camelCase `accessToken` and `dbPassword`
 * count), optionally followed by a qualifier (`SECRET_KEY_BASE`, `apiKeyId`).
 */
const SECRET_KEY = new RegExp(`(?:${SECRET_WORD}|${anyCase("authorization|cookie")})${QUALIFIER}$`);

/** Every rule, in the order applied. For docs/privacy.md and the tests. */
export const REDACTION_RULES: readonly RedactionRule[] = [
  ...TOKEN_RULES,
  URL_CREDENTIALS,
  AUTH_HEADER,
  AUTH_SCHEME,
  COOKIE_HEADER,
  ASSIGNMENT,
];

/** A string with its secrets replaced, and how many replacements were made. */
export interface RedactedText {
  readonly text: string;
  readonly count: number;
}

/** One scan that tells whether any token rule could match, before running them one by one. */
const ANY_TOKEN = new RegExp(TOKEN_RULES.map((rule) => `(?:${rule.pattern.source})`).join("|"));

/** Shorter strings cannot hold anything a rule matches (the shortest is `token=x`). */
const MIN_LENGTH = 7;

/** Replace the secrets in one string. Pure; never throws. */
export function redactText(input: string): RedactedText {
  if (input.length < MIN_LENGTH) return { text: input, count: 0 };
  let count = 0;
  let text = input;
  const anyToken = ANY_TOKEN.test(text);
  for (const rule of anyToken ? TOKEN_RULES : []) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    text = text.replace(rule.pattern, () => {
      count += 1;
      return redactionMarker(rule.id);
    });
  }
  text = text.replace(URL_CREDENTIALS.pattern, (_match, scheme: string) => {
    count += 1;
    return `${scheme}${redactionMarker(URL_CREDENTIALS.id)}@`;
  });
  text = text.replace(
    AUTH_HEADER.pattern,
    (match, name: string, separator: string, scheme: string | undefined) => {
      const value = match.slice(name.length + separator.length + (scheme?.length ?? 0));
      if (value.startsWith(MARKER_PREFIX)) return match;
      count += 1;
      return `${name}${separator}${scheme ?? ""}${redactionMarker(AUTH_HEADER.id)}`;
    },
  );
  text = text.replace(AUTH_SCHEME.pattern, (match, scheme: string, space: string) => {
    if (match.slice(scheme.length + space.length).startsWith(MARKER_PREFIX)) return match;
    count += 1;
    return `${scheme}${space}${redactionMarker(AUTH_SCHEME.id)}`;
  });
  text = text.replace(
    COOKIE_HEADER.pattern,
    (match, name: string, separator: string, value: string) => {
      if (value.trim() === "" || value.startsWith(MARKER_PREFIX)) return match;
      count += 1;
      return `${name}${separator}${redactionMarker(COOKIE_HEADER.id)}`;
    },
  );
  text = text.replace(
    ASSIGNMENT.pattern,
    (match, name: string, separator: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      const inner = quote === "" ? value : value.slice(1, -1);
      if (inner === "" || inner.startsWith(MARKER_PREFIX)) return match;
      count += 1;
      return `${name}${separator}${quote}${redactionMarker(ASSIGNMENT.id)}${quote}`;
    },
  );
  return { text, count };
}

/** A JSON value with its secrets replaced, and how many replacements were made. */
export interface RedactedValue {
  readonly value: unknown;
  readonly count: number;
}

/**
 * Walk a parsed JSON value and redact every string and key. A non-empty string under a key that
 * names a secret is replaced whole. Returns a new value; the input is not changed. Numbers,
 * booleans and null are kept as they are.
 */
export function redactJsonValue(input: unknown): RedactedValue {
  let count = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactText(value);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [rawKey, child] of Object.entries(value)) {
        const keyResult = redactText(rawKey);
        count += keyResult.count;
        let next: unknown;
        if (
          typeof child === "string" &&
          child !== "" &&
          !child.startsWith(MARKER_PREFIX) &&
          SECRET_KEY.test(rawKey)
        ) {
          count += 1;
          next = redactionMarker("key");
        } else {
          next = walk(child);
        }
        // defineProperty keeps a key such as `__proto__` an own property.
        Object.defineProperty(out, keyResult.text, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  };
  const value = walk(input);
  return { value, count };
}

/**
 * The link the CLI prints and opens: `http://127.0.0.1:<port>/#t=<token>&key=<session key>`.
 *
 * The token and the key are in the fragment, so the browser never sends them in a request line
 * or a Referer header. The app reads the fragment with `URLSearchParams` and removes it from the
 * address bar.
 */

/** Characters written as they are in a fragment value. Everything else is percent-encoded. */
const PLAIN = /^[A-Za-z0-9\-._~:]$/;

/**
 * A fragment value, percent-encoded byte by byte outside `A-Z a-z 0-9 - . _ ~ :`. A plus sign is
 * encoded too, because `URLSearchParams` reads a bare `+` as a space.
 */
export function encodeFragmentValue(value: string): string {
  let out = "";
  for (const char of value) {
    if (PLAIN.test(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** The link to the app at `origin` (`http://127.0.0.1:<port>`), with the token and the key. */
export function buildLink(origin: string, token: string, key?: string): string {
  const parts = [`t=${encodeFragmentValue(token)}`];
  if (key !== undefined) parts.push(`key=${encodeFragmentValue(key)}`);
  return `${origin}/#${parts.join("&")}`;
}

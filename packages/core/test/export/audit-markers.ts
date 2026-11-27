/**
 * Ticket #23: marker strings for the export privacy audit.
 *
 * Every marker is invented. Each one holds the token `zqx`, which appears in no fixture, no
 * schema and no code path, so finding `zqx` anywhere in an export (in any letter case) means a
 * planted value got through. Shapes that the repository's privacy check looks for (home-folder
 * paths, a key prefix) are assembled at run time from parts, so this file holds no string that
 * looks like a real path or key; the values are still fake.
 */

/** Present in every marker. Searched for case-insensitively. */
export const MARKER_TOKEN = "zqx";

const join = (parts: readonly string[], separator: string): string => parts.join(separator);

/**
 * Free text in disguise: none of these is an identifier the replay schema accepts, so none
 * may reach an export in any form, whole or in part, from any position.
 */
export const FREE_TEXT_MARKERS: readonly string[] = [
  "Zqx prompt: please move the ledger of the private zqx project to the attic.",
  join(["", "home", "zqxuser", "zqx-project", "notes.md"], "/"),
  join(["", "Users", "zqxuser", "Documents", "zqx-client"], "/"),
  join(["C:", "Users", "zqxuser", "zqx-client", "plan.txt"], "\\"),
  "zqx.person@example.com",
  "zqx first line\nsecond line\r\nthird",
  "zqx café секрет \u{1f511}",
  `zqx ${"long ".repeat(40)}`,
  "zqx\u0000nul\u001bescape",
  'zqx "quoted" <tag> & {json}',
];

/**
 * Identifier-shaped values: they match one or more of the schema's name patterns, so they
 * pass where a name is exported as written (agent type, MCP server, tool name, model id).
 * A made-up secret-shaped key and a made-up project-like name.
 */
export const IDENTIFIER_MARKERS: readonly string[] = [
  join(["sk", "ant", "api03", "ZQXfake0000token0000value"], "-"),
  "zqxtoken0fake0secret0value",
  "zqx-client-rollout",
  "Zqx_Project_Tool",
];

/** Every marker. */
export const ALL_MARKERS: readonly string[] = [...FREE_TEXT_MARKERS, ...IDENTIFIER_MARKERS];

/** True when `text` holds the marker token in any letter case. */
export function hasMarker(text: string): boolean {
  return text.toLowerCase().includes(MARKER_TOKEN);
}

/**
 * JSON pointers (`/agents/2/name`) of every string in a parsed export that holds the marker
 * token. Empty when nothing leaked.
 */
export function markerPointers(value: unknown, pointer = ""): string[] {
  if (typeof value === "string") return hasMarker(value) ? [pointer] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) => markerPointers(item, `${pointer}/${index}`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(hasMarker(key) ? [`${pointer}/${key} (key)`] : []),
      ...markerPointers(item, `${pointer}/${key}`),
    ]);
  }
  return [];
}

/**
 * Export fields where an identifier-shaped name is written as it is: the agent name and its
 * callsign (agent type), the model id and its family word, and the tool label (tool name, or
 * `mcp:<server>`). Documented as "not guaranteed" in docs/privacy.md.
 */
export const NAME_POINTERS = /^\/agents\/\d+\/(name|callsign|model|family|tools\/\d+\/name)$/;

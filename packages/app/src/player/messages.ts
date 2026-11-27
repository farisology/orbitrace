/**
 * Fixed text of the public replay player. No message includes a file name, a link or any
 * content of a file: what a visitor opened is shown only in the header label, as text.
 */

/** Where the player sends a visitor who wants to make a replay of their own session. */
export const EXPORT_DOCS_URL =
  "https://github.com/farisology/orbitrace/blob/main/docs/cli.md#orbitrace-export";

/** The command line shown on the start screen. */
export const EXPORT_COMMAND = "orbitrace export --latest -o session.replay.json";

export const PLAYER_MESSAGES = {
  subtitle: "Replay player",
  title: "Watch a shared replay",
  intro: "Open an Orbitrace replay file (.replay.json), or drop it anywhere on this page.",
  openButton: "Open a replay file",
  demoButton: "Watch the demo",
  inputLabel: "Open a replay file",
  privacy: "No server and no tracking: the file is read in your browser and is never uploaded.",
  ownReplayBefore: "To replay a session of your own, run",
  ownReplayAfter: "and open the file it writes.",
  ownReplayLink: "How to export",
  loadingLink: "Loading the linked replay…",
  dismiss: "Dismiss",
  linkEmpty: "The replay link is empty, so nothing was opened.",
  linkInvalid: "The replay link is not a valid address, so it was not opened.",
  linkNotHttp: "A linked replay opens only when this page is served over http or https.",
  linkCrossOrigin: "The replay link points to another site, so it was not opened.",
  linkCrossOriginHelp:
    "The player opens only a replay stored on the same site as this page. Download the file and open it here instead.",
  linkFailed: "The linked replay could not be loaded.",
  linkStatus: (status: number): string => `The server answered with HTTP status ${status}.`,
  linkTooLarge: (limit: string): string =>
    `The linked replay is larger than the ${limit} limit, so it was not opened.`,
  tooLarge: (size: string, limit: string): string =>
    `This file is ${size}, larger than the ${limit} limit, so it was not opened.`,
  /** A `.jsonl` transcript was opened. The player takes replay files only (decided on issue 19). */
  transcriptRefused: "This player opens replay files only, so the transcript was not opened.",
  transcriptRefusedHelp: `A transcript holds the session's private content. Export a replay first (${EXPORT_COMMAND}) and open the .replay.json file it writes.`,
  /** Any other file type. */
  unsupported: "This file type is not supported. Open a .replay.json replay file.",
} as const;

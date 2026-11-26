/**
 * Entry of @orbitrace/app for the hosts: the editor tab (#12) and the loopback server (#17).
 *
 * Hosts serve the built bundle (`@orbitrace/app/dist/*`, decision on #76); they do not import
 * the React app. What they import from here is the wire layout both sides share: the meta tag
 * names, the fragment parameters, the loopback routes, the request and message checks
 * (`protocol.ts`) and the transport types (`transport.ts`, also `@orbitrace/app/transport`).
 *
 * Built by `tsc -p tsconfig.types.json` into `dist/types` (JavaScript and declarations), which
 * the CLI leaves out when it copies the bundle it serves.
 */

export * from "./protocol.js";
export type * from "./transport.js";

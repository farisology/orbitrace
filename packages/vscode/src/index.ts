/**
 * Extension entry point. VS Code loads extensions with require(), so this package emits
 * CommonJS: it has no "type": "module" in its package.json.
 *
 * The extension does nothing yet. The editor host, the commands and the webview are built
 * in later tickets.
 */
export function activate(_context: unknown): void {
  // Intentionally empty.
}

export function deactivate(): void {
  // Intentionally empty.
}

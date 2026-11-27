/**
 * Answers the extension's dialogs in a real window (#211), the way `spies.ts` watches its panels:
 * the extension host hands one `vscode` API object to every module loaded from the extension's
 * folder, so the suite replaces `window.showInformationMessage`, `showWarningMessage`,
 * `showErrorMessage` and `showQuickPick` on that shared object while the history steps run. A
 * modal dialog would otherwise wait for a click that never comes.
 *
 * - Every call is recorded: which function, the message, its options (`modal`, `detail`) and its
 *   buttons or quick pick rows. Nothing is shown in the window.
 * - The suite sets how the next dialogs are answered (`answer`, `pick`); by default a dialog is
 *   dismissed (`undefined`), as if the user pressed Escape.
 * - `window.createOutputChannel` is wrapped, so the suite also reads the lines the extension writes
 *   to its log (the channel itself is still created and works).
 *
 * Only structural types are used for the editor API, so the module is unit tested with fakes
 * (`prompt-spies.test.ts`).
 */

/** Which dialog function was called. */
export type PromptKind = "info" | "warning" | "error" | "quickPick";

/** One recorded dialog. */
export interface PromptCall {
  readonly kind: PromptKind;
  /** The message; for a quick pick, its title or placeholder when given, else "". */
  readonly message: string;
  /** `modal` and `detail` of a message, when it was given options. */
  readonly modal: boolean;
  readonly detail: string | undefined;
  /** The buttons of a message, or the rows of a quick pick. */
  readonly items: readonly unknown[];
}

/** The part of `vscode.OutputChannel` used here. */
export interface OutputChannelLike {
  appendLine(value: string): void;
}

/** The part of `vscode.window` this module replaces. */
export interface PromptWindowLike {
  showInformationMessage(...args: never[]): unknown;
  showWarningMessage(...args: never[]): unknown;
  showErrorMessage(...args: never[]): unknown;
  showQuickPick(...args: never[]): unknown;
  createOutputChannel(...args: never[]): unknown;
}

export interface PromptSpies {
  readonly calls: PromptCall[];
  /** Lines written to output channels the extension created while installed, by channel name. */
  readonly output: Map<string, string[]>;
  /** How a message with buttons is answered: the button to choose, or undefined. */
  answer: (call: PromptCall) => string | undefined;
  /** How a quick pick is answered: the row to choose, or undefined. */
  pick: (items: readonly unknown[]) => unknown;
  /** The calls of one kind, oldest first. */
  callsOf(kind: PromptKind): PromptCall[];
  /** Put the original functions back. */
  restore(): void;
}

/** Split `(message, options?, ...items)` as the editor API takes it. */
export function splitMessageArgs(
  args: readonly unknown[],
): Pick<PromptCall, "message" | "modal" | "detail" | "items"> {
  const [message, second, ...rest] = args;
  const text = typeof message === "string" ? message : String(message);
  if (typeof second === "object" && second !== null && !Array.isArray(second)) {
    const options = second as { modal?: unknown; detail?: unknown; title?: unknown };
    // A button may itself be an object with a `title`; options never have one.
    if (options.title === undefined) {
      return {
        message: text,
        modal: options.modal === true,
        detail: typeof options.detail === "string" ? options.detail : undefined,
        items: rest,
      };
    }
  }
  return {
    message: text,
    modal: false,
    detail: undefined,
    items: second === undefined ? [] : [second, ...rest],
  };
}

/** Replace a property with a value, whether it is a field or an accessor. */
function override(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

/** Replace the dialog functions of `window` until `restore` is called. */
export function installPromptSpies(window: PromptWindowLike): PromptSpies {
  const target = window as unknown as Record<string, unknown>;
  const names = [
    "showInformationMessage",
    "showWarningMessage",
    "showErrorMessage",
    "showQuickPick",
    "createOutputChannel",
  ] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(target, name)]),
  );
  const createOriginal = window.createOutputChannel.bind(window) as (...args: unknown[]) => unknown;
  const spies: PromptSpies = {
    calls: [],
    output: new Map(),
    answer: () => undefined,
    pick: () => undefined,
    callsOf: (kind) => spies.calls.filter((call) => call.kind === kind),
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor === undefined) delete target[name];
        else Object.defineProperty(target, name, descriptor);
      }
    },
  };
  const message =
    (kind: Exclude<PromptKind, "quickPick">) =>
    async (...args: unknown[]): Promise<unknown> => {
      const call: PromptCall = { kind, ...splitMessageArgs(args) };
      spies.calls.push(call);
      return call.items.length === 0 ? undefined : spies.answer(call);
    };
  override(target, "showInformationMessage", message("info"));
  override(target, "showWarningMessage", message("warning"));
  override(target, "showErrorMessage", message("error"));
  override(target, "showQuickPick", async (items: unknown, options?: unknown): Promise<unknown> => {
    const rows = Array.isArray(items) ? items : await Promise.resolve(items);
    const list = Array.isArray(rows) ? (rows as unknown[]) : [];
    const opts = (options ?? {}) as { title?: unknown; placeHolder?: unknown };
    const title = typeof opts.title === "string" ? opts.title : "";
    spies.calls.push({
      kind: "quickPick",
      message: title,
      modal: false,
      detail: undefined,
      items: list,
    });
    return spies.pick(list);
  });
  override(target, "createOutputChannel", (...args: unknown[]): unknown => {
    const channel = createOriginal(...args) as OutputChannelLike;
    const name = typeof args[0] === "string" ? args[0] : "";
    const lines: string[] = spies.output.get(name) ?? [];
    spies.output.set(name, lines);
    const appendLine = channel.appendLine.bind(channel);
    override(channel, "appendLine", (value: string) => {
      lines.push(value);
      appendLine(value);
    });
    return channel;
  });
  return spies;
}

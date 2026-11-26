/**
 * A small fake of the `vscode` module: only the parts the extension uses. vitest.config.mts
 * aliases `vscode` to this file, and the bundle test hands it to `require("vscode")`.
 * `fake` records what the extension did and lets a test answer prompts.
 */

import { posix } from "node:path";

type Listener<T> = (value: T) => unknown;

export class Disposable {
  private done = false;
  constructor(private readonly callOnDispose: () => unknown) {}
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
  dispose(): void {
    if (this.done) return;
    this.done = true;
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  get listenerCount(): number {
    return this.listeners.size;
  }
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static file(path: string): Uri {
    return new Uri("file", path);
  }
  static from(parts: { scheme: string; path: string }): Uri {
    return new Uri(parts.scheme, parts.path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, posix.join(base.path, ...segments));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState,
  ) {}
}

/** The `webview.cspSource` the fake reports: the value VS Code itself returns. */
export const FAKE_CSP_SOURCE = "'self' https://*.vscode-cdn.net";

export class FakeWebview {
  html = "";
  readonly cspSource = FAKE_CSP_SOURCE;
  readonly posted: unknown[] = [];
  closed = false;
  private readonly received = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.received.event;
  constructor(readonly options: Record<string, unknown>) {}
  asWebviewUri(uri: Uri): Uri {
    return Uri.from({ scheme: "https", path: `/webview-resource.example${uri.path}` });
  }
  postMessage(message: unknown): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error("Webview is disposed"));
    // Structured clone, as the real webview does: a value that cannot be cloned throws.
    this.posted.push(structuredClone(message));
    return Promise.resolve(true);
  }
  /** Deliver a message as if the app had posted it. */
  receive(message: unknown): void {
    this.received.fire(message);
  }
  get receiverCount(): number {
    return this.received.listenerCount;
  }
}

export class FakeWebviewPanel {
  readonly webview: FakeWebview;
  iconPath: unknown;
  revealCount = 0;
  disposed = false;
  private readonly disposeEvent = new EventEmitter<void>();
  readonly onDidDispose = this.disposeEvent.event;
  constructor(
    readonly viewType: string,
    public title: string,
    readonly showOptions: unknown,
    readonly options: Record<string, unknown>,
  ) {
    this.webview = new FakeWebview(options);
  }
  reveal(): void {
    this.revealCount += 1;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.webview.closed = true;
    this.disposeEvent.fire();
  }
}

export class FakeTreeView<T> {
  message: string | undefined;
  disposed = false;
  private readonly visibility = new EventEmitter<{ visible: boolean }>();
  readonly onDidChangeVisibility = this.visibility.event;
  constructor(
    readonly id: string,
    readonly treeDataProvider: {
      getChildren(node?: T): Promise<T[]> | T[];
      getTreeItem(node: T): TreeItem;
      onDidChangeTreeData?: (listener: Listener<unknown>) => Disposable;
    },
  ) {}
  setVisible(visible: boolean): void {
    this.visibility.fire({ visible });
  }
  dispose(): void {
    this.disposed = true;
  }
}

type QuickPickAnswer = (items: readonly unknown[], options: unknown) => unknown;

/** What the extension did, and how prompts are answered. */
export const fake = {
  panels: [] as FakeWebviewPanel[],
  treeViews: [] as FakeTreeView<unknown>[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  infos: [] as string[],
  errors: [] as string[],
  quickPickCalls: [] as { items: readonly unknown[]; options: unknown }[],
  quickPick: (() => undefined) as QuickPickAnswer,
  reset(): void {
    fake.panels.length = 0;
    fake.treeViews.length = 0;
    fake.commands.clear();
    fake.infos.length = 0;
    fake.errors.length = 0;
    fake.quickPickCalls.length = 0;
    fake.quickPick = () => undefined;
    workspace.workspaceFolders = undefined;
  },
};

export const window = {
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options: Record<string, unknown>,
  ): FakeWebviewPanel {
    const panel = new FakeWebviewPanel(viewType, title, showOptions, options);
    fake.panels.push(panel);
    return panel;
  },
  createTreeView<T>(
    id: string,
    options: { treeDataProvider: FakeTreeView<T>["treeDataProvider"] },
  ): FakeTreeView<T> {
    const view = new FakeTreeView<T>(id, options.treeDataProvider);
    fake.treeViews.push(view as FakeTreeView<unknown>);
    return view;
  },
  async showQuickPick(items: readonly unknown[], options: unknown): Promise<unknown> {
    fake.quickPickCalls.push({ items, options });
    return fake.quickPick(items, options);
  },
  async showInformationMessage(message: string): Promise<undefined> {
    fake.infos.push(message);
    return undefined;
  },
  async showErrorMessage(message: string): Promise<undefined> {
    fake.errors.push(message);
    return undefined;
  },
};

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): Disposable {
    if (fake.commands.has(id)) throw new Error(`command already registered: ${id}`);
    fake.commands.set(id, callback);
    return new Disposable(() => fake.commands.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const callback = fake.commands.get(id);
    if (callback === undefined) throw new Error(`command not found: ${id}`);
    return callback(...args);
  },
};

export const workspace = {
  workspaceFolders: undefined as
    undefined | { uri: { scheme: string; fsPath: string }; name: string; index: number }[],
};

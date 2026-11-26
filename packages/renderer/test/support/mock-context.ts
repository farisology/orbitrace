/**
 * A 2D context stand-in. In recording mode it logs every call and every property write, so a
 * test can assert what was drawn. With recording off it does nothing and allocates nothing,
 * for the allocation test.
 */

import type { DrawContext, OrreryEnvironment, SpriteSurface } from "../../src/context.js";

export type Op = { readonly op: string; readonly args: readonly unknown[] };

export class MockGradient {
  readonly stops: [number, string][] = [];
  addColorStop(offset: number, color: string): void {
    this.stops.push([offset, color]);
  }
}

const METRICS = { width: 0 };

export class MockContext {
  ops: Op[] = [];
  recording: boolean;
  measureCount = 0;
  private state = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000" as unknown,
    strokeStyle: "#000" as unknown,
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    lineDashOffset: 0,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
  };

  constructor(recording = true) {
    this.recording = recording;
  }

  private log(op: string, args: readonly unknown[]): void {
    if (this.recording) this.ops.push({ op, args: [...args] });
  }
  private set<K extends keyof MockContext["state"]>(key: K, value: MockContext["state"][K]): void {
    this.state[key] = value;
    if (this.recording) this.ops.push({ op: `set:${key}`, args: [value] });
  }

  get globalAlpha() {
    return this.state.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.set("globalAlpha", v);
  }
  get globalCompositeOperation() {
    return this.state.globalCompositeOperation;
  }
  set globalCompositeOperation(v: string) {
    this.set("globalCompositeOperation", v);
  }
  get fillStyle() {
    return this.state.fillStyle;
  }
  set fillStyle(v: unknown) {
    this.set("fillStyle", v);
  }
  get strokeStyle() {
    return this.state.strokeStyle;
  }
  set strokeStyle(v: unknown) {
    this.set("strokeStyle", v);
  }
  get lineWidth() {
    return this.state.lineWidth;
  }
  set lineWidth(v: number) {
    this.set("lineWidth", v);
  }
  get lineJoin() {
    return this.state.lineJoin;
  }
  set lineJoin(v: string) {
    this.set("lineJoin", v);
  }
  get lineCap() {
    return this.state.lineCap;
  }
  set lineCap(v: string) {
    this.set("lineCap", v);
  }
  get lineDashOffset() {
    return this.state.lineDashOffset;
  }
  set lineDashOffset(v: number) {
    this.set("lineDashOffset", v);
  }
  get font() {
    return this.state.font;
  }
  set font(v: string) {
    this.set("font", v);
  }
  get textAlign() {
    return this.state.textAlign;
  }
  set textAlign(v: string) {
    this.set("textAlign", v);
  }
  get textBaseline() {
    return this.state.textBaseline;
  }
  set textBaseline(v: string) {
    this.set("textBaseline", v);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (this.recording) this.ops.push({ op: "setTransform", args: [a, b, c, d, e, f] });
  }
  save(): void {
    if (this.recording) this.ops.push({ op: "save", args: [] });
  }
  restore(): void {
    if (this.recording) this.ops.push({ op: "restore", args: [] });
  }
  translate(x: number, y: number): void {
    if (this.recording) this.ops.push({ op: "translate", args: [x, y] });
  }
  rotate(a: number): void {
    if (this.recording) this.ops.push({ op: "rotate", args: [a] });
  }
  setLineDash(segments: number[]): void {
    if (this.recording) this.ops.push({ op: "setLineDash", args: [segments] });
  }
  beginPath(): void {
    if (this.recording) this.ops.push({ op: "beginPath", args: [] });
  }
  closePath(): void {
    if (this.recording) this.ops.push({ op: "closePath", args: [] });
  }
  moveTo(x: number, y: number): void {
    if (this.recording) this.ops.push({ op: "moveTo", args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    if (this.recording) this.ops.push({ op: "lineTo", args: [x, y] });
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    if (this.recording) this.ops.push({ op: "arc", args: [x, y, r, a0, a1] });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (this.recording) this.ops.push({ op: "quadraticCurveTo", args: [cx, cy, x, y] });
  }
  rect(x: number, y: number, w: number, h: number): void {
    if (this.recording) this.ops.push({ op: "rect", args: [x, y, w, h] });
  }
  fill(): void {
    if (this.recording)
      this.ops.push({ op: "fill", args: [this.state.fillStyle, this.state.globalAlpha] });
  }
  stroke(): void {
    if (this.recording)
      this.ops.push({ op: "stroke", args: [this.state.strokeStyle, this.state.globalAlpha] });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.recording) this.ops.push({ op: "fillRect", args: [x, y, w, h, this.state.fillStyle] });
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    if (this.recording) this.ops.push({ op: "clearRect", args: [x, y, w, h] });
  }
  fillText(text: string, x: number, y: number): void {
    if (this.recording) this.ops.push({ op: "fillText", args: [text, x, y, this.state.fillStyle] });
  }
  measureText(text: string): { width: number } {
    this.measureCount++;
    METRICS.width = text.length * 6;
    return this.recording ? { width: text.length * 6 } : METRICS;
  }
  drawImage(image: unknown, x: number, y: number): void {
    if (this.recording) this.ops.push({ op: "drawImage", args: [image, x, y] });
  }
  createRadialGradient(...args: number[]): MockGradient {
    this.log("createRadialGradient", args);
    return new MockGradient();
  }
  createLinearGradient(...args: number[]): MockGradient {
    this.log("createLinearGradient", args);
    return new MockGradient();
  }
  createConicGradient(...args: number[]): MockGradient {
    this.log("createConicGradient", args);
    return new MockGradient();
  }

  /** This mock typed as the engine's context. */
  asDrawContext(): DrawContext {
    return this as unknown as DrawContext;
  }

  /** Drawing ops only: without the one-off gradient creation of the first frame at a size. */
  drawOps(): Op[] {
    return this.ops.filter((o) => !o.op.startsWith("create"));
  }
  count(op: string): number {
    return this.ops.filter((o) => o.op === op).length;
  }
  texts(): string[] {
    return this.ops.filter((o) => o.op === "fillText").map((o) => o.args[0] as string);
  }
  clear(): void {
    this.ops = [];
  }
}

/** A surface factory that hands out mock contexts. */
export function mockSurfaces(): {
  created: number;
  createSurface(width: number, height: number): SpriteSurface;
} {
  const env = {
    created: 0,
    createSurface(width: number, height: number): SpriteSurface {
      env.created++;
      const context = new MockContext(false);
      return {
        image: { width, height } as unknown as CanvasImageSource,
        context: context.asDrawContext(),
      };
    },
  };
  return env;
}

type Handler = (event: unknown) => void;

/** A canvas stand-in with a mock context and recorded listeners. */
export class FakeCanvas {
  width = 300;
  height = 150;
  clientWidth: number;
  clientHeight: number;
  style = { cursor: "" };
  readonly context = new MockContext(true);
  readonly handlers = new Map<string, Set<Handler>>();

  constructor(width = 800, height = 600) {
    this.clientWidth = width;
    this.clientHeight = height;
  }
  getContext(kind: string): unknown {
    return kind === "2d" ? this.context : null;
  }
  addEventListener(type: string, handler: Handler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.handlers.get(type)?.delete(handler);
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  dispatch(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  listenerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
  asCanvas(): HTMLCanvasElement {
    return this as unknown as HTMLCanvasElement;
  }
}

/** A manual frame scheduler: frames run only when the test calls `flush`. */
export class FakeEnvironment implements OrreryEnvironment {
  private queue = new Map<number, (now: number) => void>();
  private nextHandle = 1;
  requested = 0;
  cancelled = 0;
  now = 0;
  surfaces = mockSurfaces();

  constructor(
    private readonly reduced = false,
    private readonly dpr = 2,
  ) {}

  requestFrame(callback: (now: number) => void): number {
    this.requested++;
    const handle = this.nextHandle++;
    this.queue.set(handle, callback);
    return handle;
  }
  cancelFrame(handle: number): void {
    if (this.queue.delete(handle)) this.cancelled++;
  }
  prefersReducedMotion(): boolean {
    return this.reduced;
  }
  devicePixelRatio(): number {
    return this.dpr;
  }
  createSurface(width: number, height: number): SpriteSurface {
    return this.surfaces.createSurface(width, height);
  }
  get pending(): number {
    return this.queue.size;
  }
  /** Run every queued frame once, `stepMs` after the previous flush. Returns how many ran. */
  flush(stepMs = 16): number {
    this.now += stepMs;
    const callbacks = [...this.queue.values()];
    this.queue.clear();
    for (const callback of callbacks) callback(this.now);
    return callbacks.length;
  }
}

/** Entry of @orbitrace/app for code that embeds the app (the editor tab, #12; the browser host, #16). */
export { App, APP_MESSAGES, liveLabel, sourceLabel, type AppProps, type ReplaySource } from "./App";
export { OrreryFactoryContext, type OrreryFactory } from "./components/OrreryView";
export { createDemoTransport, DEMO_SESSION, DEMO_SESSION_KEY } from "./demo-session";
export {
  createNoHostTransport,
  isTransportError,
  transportError,
  type BundledSession,
} from "./no-host-transport";
export { parseStartOptions, type StartOptions } from "./url-state";
export type * from "./transport";

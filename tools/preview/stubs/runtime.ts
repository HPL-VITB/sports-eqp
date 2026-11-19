import type { AppContext } from "../../../src/server/context";
export function getAppContext(): AppContext {
  const c = (globalThis as { __ctx?: AppContext }).__ctx;
  if (!c) throw new Error("preview context not set");
  return c;
}

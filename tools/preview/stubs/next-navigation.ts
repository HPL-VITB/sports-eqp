export class NavigationSignal extends Error { constructor(public kind: "redirect" | "notFound", public to?: string) { super(`${kind} ${to ?? ""}`); } }
export function redirect(to: string): never { throw new NavigationSignal("redirect", to); }
export function notFound(): never { throw new NavigationSignal("notFound"); }
export function useRouter() { return { push(_: string) {}, replace(_: string) {}, refresh() {}, back() {} }; }
export function useSearchParams() { return new URLSearchParams(); }
export function usePathname() { return (globalThis as { __path?: string }).__path ?? "/"; }

// Preview/type-check stand-in for React. NOT used by the real app (Next.js bundles real React).
export type ReactNode = string | number | boolean | null | undefined | ReactElement | Iterable<ReactNode>;
export interface ReactElement { type: unknown; props: Record<string, unknown>; key?: unknown }
export type FormEvent<T = Element> = { preventDefault(): void; currentTarget: T; target: EventTarget | null };
export type ChangeEvent<T = Element> = { target: T; currentTarget: T };
export type SetState<S> = (v: S | ((prev: S) => S)) => void;
export function useState<S>(init: S | (() => S)): [S, SetState<S>] {
  return [typeof init === "function" ? (init as () => S)() : init, () => {}];
}
export function useEffect(_f: () => unknown, _deps?: unknown[]): void {}
export function useMemo<T>(f: () => T, _deps: unknown[]): T { return f(); }
export function useCallback<T>(f: T, _deps: unknown[]): T { return f; }
export function useRef<T>(v: T): { current: T } { return { current: v }; }
export const Fragment = Symbol.for("fragment");
const React = { useState, useEffect, useMemo, useCallback, useRef, Fragment };
export default React;

import { Fragment, type ReactElement, type ReactNode } from "./react";
export { Fragment };
export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): ReactElement { return { type, props, key }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
type Field = HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
type Ev<T> = { target: T; currentTarget: T; preventDefault(): void; stopPropagation(): void; key: string };
type Loose = {
  [attr: string]: unknown;
  children?: ReactNode;
  style?: Record<string, string | number | undefined>;
  onChange?: (e: Ev<Field>) => void;
  onInput?: (e: Ev<Field>) => void;
  onBlur?: (e: Ev<Field>) => void;
  onKeyDown?: (e: Ev<Field>) => void;
  onClick?: (e: Ev<HTMLElement>) => void;
  onSubmit?: (e: Ev<HTMLFormElement>) => void | Promise<void>;
};
export namespace JSX {
  export type Element = ReactElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ElementType = string | ((props: any) => ReactNode | Promise<ReactNode>);
  export interface ElementChildrenAttribute { children: unknown }
  export interface IntrinsicAttributes { key?: string | number | null }
  export interface IntrinsicElements { [tag: string]: Loose }
}

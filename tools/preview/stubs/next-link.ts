import { jsx } from "./jsx-runtime";
import type { ReactNode } from "./react";
export default function Link({ href, children, ...rest }: { href: string; children?: ReactNode; [k: string]: unknown }) {
  return jsx("a", { href, ...rest, children });
}

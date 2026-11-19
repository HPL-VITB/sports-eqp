/**
 * Minimal server renderer for the preview stand-in React: awaits async (server) components and turns the tree into HTML.
 * Client components render their first state only (effects do not run), as a server-side render would.
 */
import { Fragment, type ReactElement } from "react";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ATTR: Record<string, string> = { className: "class", htmlFor: "for", defaultValue: "value", defaultChecked: "checked", colSpan: "colspan", maxLength: "maxlength", readOnly: "readonly", autoComplete: "autocomplete", inputMode: "inputmode", autoFocus: "autofocus", tabIndex: "tabindex" };
const css = (o: Record<string, unknown>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${typeof v === "number" && !/flex|weight|opacity|zIndex/i.test(k) ? `${v}px` : v}`).join(";");

export async function render(node: unknown, selectValue?: string): Promise<string> {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return esc(String(node));
  if (node instanceof Promise) return render(await node, selectValue);
  if (Array.isArray(node) || (typeof node === "object" && Symbol.iterator in (node as object) && !("type" in (node as object)))) {
    let out = "";
    for (const c of node as Iterable<unknown>) out += await render(c, selectValue);
    return out;
  }
  const el = node as ReactElement;
  const props = el.props ?? {};
  if (el.type === Fragment) return render(props.children, selectValue);
  if (typeof el.type === "function") return render(await (el.type as (p: unknown) => unknown)(props), selectValue);
  const tag = el.type as string;
  let attrs = "";
  let childSelect = selectValue;
  for (const [k, v] of Object.entries(props)) {
    if (k === "children" || k === "key" || /^on[A-Z]/.test(k) || v === undefined || v === null || v === false) continue;
    if (tag === "select" && (k === "defaultValue" || k === "value")) { childSelect = String(v); continue; }
    if (tag === "textarea" && (k === "defaultValue" || k === "value")) continue;
    const name = ATTR[k] ?? (k.startsWith("aria") || k.startsWith("data") ? k : k.toLowerCase());
    if (k === "style") attrs += ` style="${esc(css(v as Record<string, unknown>))}"`;
    else if (v === true) attrs += ` ${name}`;
    else attrs += ` ${name}="${esc(String(v))}"`;
  }
  if (tag === "option" && selectValue !== undefined && String(props.value ?? "") === selectValue) attrs += " selected";
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  const inner = tag === "textarea" ? esc(String(props.defaultValue ?? props.value ?? "")) : await render(props.children, tag === "select" ? childSelect : selectValue);
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

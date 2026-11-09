export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function setText(
  node: Element | null | undefined,
  value: string
): void {
  if (node) node.textContent = value;
}

export function show(node: HTMLElement, visible = true): void {
  node.hidden = !visible;
}

export function makeButton(
  label: string,
  className: string,
  onClick: () => void
): HTMLButtonElement {
  const button = el("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function makeIcon(ref: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("ic");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${ref}`);
  svg.append(use);
  return svg;
}

export function statusTag(
  label: string,
  tone: "open" | "locked" | "settled" | "void" | "yes" | "no"
): HTMLElement {
  const tag = el("span", `tag tag--${tone}`);
  const dot = el("i");
  dot.setAttribute("aria-hidden", "true");
  tag.append(dot, document.createTextNode(label));
  return tag;
}

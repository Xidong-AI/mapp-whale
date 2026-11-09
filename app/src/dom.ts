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

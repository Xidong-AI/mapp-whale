import copy from "./strings.json";

type Vars = Record<string, string | number>;

const dictionary = copy.zh_CN as Record<string, unknown>;

function lookup(key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      dictionary
    );
  return typeof value === "string" ? value : key;
}

export function t(key: string, vars: Vars = {}): string {
  return lookup(key).replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(vars[name] ?? "")
  );
}

export function applyCopy(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-text]").forEach((node) => {
    node.textContent = t(node.dataset.text ?? "");
  });
  root.querySelectorAll<HTMLElement>("[data-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.ariaLabel ?? ""));
  });
}


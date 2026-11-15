import { el } from "./editor/dom";

/**
 * Shared dialog furniture: a ✕ close button in the top-right corner of every modal dialog, and a search box
 * for dialogs with long lists (library, saved scenarios, roster).
 */

const CLOSE_CLASS = "dialog-x";

/**
 * Closes a dialog the way Escape does: a `cancel` event first (a listener may prevent it), then close().
 */
export function cancelDialog(d: HTMLDialogElement): void {
  if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
}

function closeButton(d: HTMLDialogElement): HTMLElement {
  const b = el(
    "button",
    {
      class: CLOSE_CLASS,
      type: "button",
      title: "Close (Esc)",
      "aria-label": "Close",
      "data-testid": `${d.dataset.testid ?? "dialog"}-x`,
    },
    "✕",
  );
  b.addEventListener("click", () => cancelDialog(d));
  return b;
}

const watched = new WeakSet<HTMLDialogElement>();

/** Puts the ✕ button on a dialog and keeps it there when the dialog's content is rebuilt. */
export function ensureCloseButton(d: HTMLDialogElement): void {
  if (d.hasAttribute("data-no-close")) return;
  const add = () => {
    if (!d.querySelector(`:scope > .${CLOSE_CLASS}`)) d.prepend(closeButton(d));
  };
  add();
  if (watched.has(d)) return;
  watched.add(d);
  new MutationObserver(add).observe(d, { childList: true });
}

let installed = false;

/** Every modal dialog opened from now on gets the ✕ button (call once at start-up). */
export function installDialogChrome(): void {
  if (installed || typeof HTMLDialogElement === "undefined") return;
  installed = true;
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    ensureCloseButton(this);
    showModal.call(this);
  };
}

/**
 * Hides the rows of `list` (elements with `data-search`) that do not contain every word of `query`, and the
 * sections (`details`) left empty; a section with matches opens.
 */
export function filterList(list: HTMLElement, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const row of list.querySelectorAll<HTMLElement>("[data-search]")) {
    const hit = words.every((w) => row.dataset.search!.toLowerCase().includes(w));
    if (row.hidden === hit) row.hidden = !hit;
    if (hit) shown++;
  }
  for (const d of list.querySelectorAll<HTMLDetailsElement>("details")) {
    const any = !!d.querySelector("[data-search]:not([hidden])");
    const hide = words.length > 0 && !any;
    if (d.hidden !== hide) d.hidden = hide;
    if (words.length && any && !d.open) d.open = true;
  }
  return shown;
}

/**
 * A search box filtering `list` as you type. The filter stays applied when the list is rebuilt; `onChange`
 * lets a dialog that rebuilds itself keep the query.
 */
export function listSearch(
  list: HTMLElement,
  opts: { testid: string; placeholder?: string; value?: string; onChange?: (q: string) => void },
): HTMLInputElement {
  const input = el("input", {
    type: "search",
    class: "list-search",
    placeholder: opts.placeholder ?? "Search…",
    "aria-label": opts.placeholder ?? "Search",
    "data-testid": opts.testid,
    value: opts.value ?? "",
  }) as HTMLInputElement;
  const apply = () => filterList(list, input.value);
  input.addEventListener("input", () => {
    apply();
    opts.onChange?.(input.value);
  });
  new MutationObserver(apply).observe(list, { childList: true, subtree: true });
  apply();
  return input;
}

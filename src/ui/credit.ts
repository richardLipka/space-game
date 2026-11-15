import { el } from "./editor/dom";

/** Author and homepage, shown small in the editors' corner and in the About page of the help dialog. */
export const AUTHOR = "Richard Lipka";
export const HOMEPAGE = "https://home.zcu.cz/~lipka/";
export const COPYRIGHT = `© 2026 ${AUTHOR}`;

/** A link to the author's homepage (opens in a new tab). */
export function creditLink(text = COPYRIGHT, cls = "credit-link"): HTMLAnchorElement {
  return el(
    "a",
    { class: cls, href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer", title: HOMEPAGE },
    text,
  ) as HTMLAnchorElement;
}

/** The small footnote in the corner of an editor's status bar (not shown while flying or commanding). */
export const creditFoot = (testid: string): HTMLElement =>
  el("div", { class: "credit-foot", "data-testid": testid }, creditLink());

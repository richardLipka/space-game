import type { ShipDesign } from "../../data/schemas/design";
import { designSection, orderSections, SECTIONS } from "../../data/designs/index";
import { designsUsingPart } from "../../data/share/library";
import type { EditorServices } from "./editor-screen";
import { el } from "./dom";

/** Library browser: saved designs (load/delete) and user parts with "used by" (spec §4.5). */
export class LibraryDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;

  constructor(
    private readonly services: EditorServices,
    private readonly onLoad: (d: ShipDesign) => void,
  ) {
    this.list = el("div", { class: "lib-list", "data-testid": "library-list" });
    const close = el("button", { "data-testid": "btn-library-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog = el(
      "dialog",
      { class: "ed-dialog", "data-testid": "library-dialog" },
      el("h2", {}, "Library"),
      this.list,
      el("div", { class: "actions" }, close),
    ) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  async open(): Promise<void> {
    await this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private async render(): Promise<void> {
    const lib = this.services.library;
    const [designs, parts] = await Promise.all([lib.listDesigns(), lib.listParts()]);
    this.list.replaceChildren(el("h3", {}, `Designs (${designs.length})`));
    if (designs.length === 0) this.list.append(el("p", { class: "dim" }, "Nothing saved yet."));
    const bySection = new Map<string, ShipDesign[]>();
    for (const d of designs) {
      const s = designSection(d);
      bySection.set(s, [...(bySection.get(s) ?? []), d]);
    }
    const sections = orderSections([...SECTIONS, ...bySection.keys()]);
    for (const section of orderSections(bySection.keys())) {
      const group = el("details", { class: "lib-section", "data-section": section });
      if (!this.collapsed.has(section)) group.setAttribute("open", "");
      group.addEventListener("toggle", () => {
        if ((group as HTMLDetailsElement).open) this.collapsed.delete(section);
        else this.collapsed.add(section);
      });
      group.append(el("summary", {}, `${section} (${bySection.get(section)!.length})`));
      this.list.append(group);
      for (const d of bySection.get(section)!) group.append(this.designRow(d, section, sections));
    }
    await this.renderParts(parts);
  }

  /** Sections folded shut (kept while the dialog is reopened). */
  private readonly collapsed = new Set<string>();

  private designRow(d: ShipDesign, section: string, sections: readonly string[]): HTMLElement {
    const lib = this.services.library;
    const cat = this.services.catalogue();
    const cost = d.parts.reduce((s, p) => s + (cat.has(p.partId) ? cat.get(p.partId).def.cost : 0), 0);
    const load = el("button", { "data-testid": `lib-load-${d.id}` }, "Load");
    load.addEventListener("click", () => {
      this.dialog.close();
      this.onLoad(d);
    });
    const del = el("button", { "data-testid": `lib-delete-${d.id}`, class: "danger" }, "Delete");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete “${d.name}” from the library? This cannot be undone.`)) return;
      await lib.deleteDesign(d.id);
      await this.render();
    });
    // Move to another section (or a new one).
    const move = el("select", { "data-testid": `lib-section-${d.id}`, title: "Library section" });
    for (const name of [...sections, "New section…"]) {
      const o = el("option", { value: name }, name) as HTMLOptionElement;
      if (name === section) o.selected = true;
      move.append(o);
    }
    move.addEventListener("change", async () => {
      let to: string | null = (move as HTMLSelectElement).value;
      if (to === "New section…") to = prompt("Name of the new section:")?.trim().slice(0, 40) || null;
      if (!to || to === section) {
        (move as HTMLSelectElement).value = section;
        return;
      }
      await lib.putDesign({ ...d, section: to });
      await this.render();
    });
    return el(
      "div",
      { class: "lib-item", "data-design": d.id },
      el("span", { class: "name" }, d.name, d.drone ? " (drone)" : ""),
      el("span", { class: "dim" }, `${d.parts.length} parts · cost ${cost} · ${d.modifiedAt.slice(0, 10)}`),
      move,
      load,
      del,
    );
  }

  private async renderParts(parts: Awaited<ReturnType<EditorServices["library"]["listParts"]>>) {
    const lib = this.services.library;
    this.list.append(el("h3", {}, `User parts (${parts.length})`));
    if (parts.length === 0)
      this.list.append(el("p", { class: "dim" }, "Imported and edited parts appear here."));
    for (const p of parts) {
      const usedBy = await designsUsingPart(lib, p.def.id);
      this.list.append(
        el(
          "div",
          { class: "lib-item" },
          el("span", { class: "name" }, p.def.name),
          el(
            "span",
            { class: "dim" },
            `${p.def.id}${p.importedFrom ? ` · from ${p.importedFrom}` : ""} · used by ${usedBy.length}`,
          ),
        ),
      );
    }
  }
}

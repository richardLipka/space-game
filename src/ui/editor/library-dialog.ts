import type { ShipDesign } from "../../data/schemas/design";
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
    const cat = this.services.catalogue();
    this.list.replaceChildren(el("h3", {}, `Designs (${designs.length})`));
    if (designs.length === 0) this.list.append(el("p", { class: "dim" }, "Nothing saved yet."));
    for (const d of designs) {
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
      this.list.append(
        el(
          "div",
          { class: "lib-item", "data-design": d.id },
          el("span", { class: "name" }, d.name, d.drone ? " (drone)" : ""),
          el(
            "span",
            { class: "dim" },
            `${d.parts.length} parts · cost ${cost} · ${d.modifiedAt.slice(0, 10)}`,
          ),
          load,
          del,
        ),
      );
    }
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

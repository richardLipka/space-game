import type { ShipDesign } from "../../data/schemas/design";
import { analyzeImport, applyImport, type ConflictChoice, type ImportPlan } from "../../data/share/import";
import { librarySnapshot } from "../../data/share/library";
import type { EditorServices } from "./editor-screen";
import { el } from "./dom";

/**
 * Import dialog (spec §4.5): paste JSON or an SG1 code, pick or drop a file; shows the analysis
 * (errors, warnings, conflicts) and applies it to the library.
 */
export class ImportDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly text: HTMLTextAreaElement;
  private readonly result: HTMLElement;
  private readonly options: HTMLElement;
  private readonly importBtn: HTMLButtonElement;
  private readonly title: HTMLElement;
  private plan: ImportPlan | null = null;
  private seq = 0;

  constructor(
    private readonly services: EditorServices,
    private readonly onLoaded: (d: ShipDesign) => void,
  ) {
    this.title = el("h2", {}, "Import ship");
    this.text = el("textarea", {
      "data-testid": "import-text",
      rows: "8",
      spellcheck: "false",
      placeholder: "Paste ship JSON or an SG1: share code, or drop a .ship.json file here",
    }) as HTMLTextAreaElement;
    this.text.addEventListener("input", () => void this.analyze());
    const file = el("input", {
      type: "file",
      accept: ".json,application/json,text/plain",
      "data-testid": "import-file",
    }) as HTMLInputElement;
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) void f.text().then((t) => this.setText(t));
    });
    this.result = el("div", { class: "imp-result", "data-testid": "import-result" });
    this.options = el("div", { class: "imp-options" });
    this.importBtn = el(
      "button",
      { "data-testid": "btn-do-import", class: "primary" },
      "Import",
    ) as HTMLButtonElement;
    this.importBtn.addEventListener("click", () => void this.apply());
    const close = el("button", { "data-testid": "btn-import-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog = el(
      "dialog",
      { class: "ed-dialog", "data-testid": "import-dialog" },
      this.title,
      this.text,
      el("div", { class: "row" }, file),
      this.result,
      this.options,
      el("div", { class: "actions" }, this.importBtn, close),
    ) as HTMLDialogElement;
    this.dialog.addEventListener("dragover", (e) => e.preventDefault());
    this.dialog.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer?.files?.[0];
      if (f) void f.text().then((t) => this.setText(t));
    });
    document.body.append(this.dialog);
  }

  open(text: string, source?: string): void {
    this.title.textContent = source ? `Import ${source}` : "Import ship";
    this.text.readOnly = false;
    this.importBtn.hidden = false;
    if (!this.dialog.open) this.dialog.showModal();
    this.setText(text);
  }

  /** Fallback when the clipboard is unavailable: show text to copy manually. */
  showText(text: string, title: string): void {
    this.title.textContent = `${title} — copy it from here`;
    this.text.value = text;
    this.text.readOnly = true;
    this.result.replaceChildren();
    this.options.replaceChildren();
    this.importBtn.hidden = true;
    if (!this.dialog.open) this.dialog.showModal();
    this.text.select();
  }

  private setText(t: string): void {
    this.text.value = t;
    void this.analyze();
  }

  private async analyze(): Promise<void> {
    const seq = ++this.seq;
    this.plan = null;
    this.importBtn.disabled = true;
    this.options.replaceChildren();
    const text = this.text.value;
    if (!text.trim()) {
      this.result.replaceChildren();
      return;
    }
    const snap = await librarySnapshot(this.services.library);
    if (seq !== this.seq) return;
    const r = analyzeImport(text, {
      core: this.services.core(),
      userParts: snap.userParts,
      designs: snap.designs,
    });
    if (!r.ok) {
      this.result.replaceChildren(
        el("p", { class: "error" }, "Cannot import:"),
        ...r.errors.slice(0, 12).map((e) => el("div", { class: "issue error" }, e)),
      );
      return;
    }
    const p = r.plan;
    this.plan = p;
    const root = p.designs[0]!;
    this.result.replaceChildren(
      el(
        "p",
        {},
        `“${root.name}” by ${p.author} · ${root.parts.length} parts`,
        p.designs.length > 1 ? ` · +${p.designs.length - 1} drone design(s)` : "",
      ),
      el(
        "p",
        { class: "dim" },
        `${p.newParts.length} new part(s), ${p.reused.length} already in your library`,
      ),
      ...p.warnings.map((w) => el("div", { class: "issue warning" }, w)),
    );
    if (p.designConflicts.length) {
      const group = el(
        "div",
        { class: "imp-conflict", "data-testid": "import-conflict" },
        el("p", {}, `A design with id ${p.designConflicts.join(", ")} already exists:`),
      );
      for (const [value, label] of [
        ["keep-both", "Keep both"],
        ["replace", "Replace mine"],
        ["cancel", "Cancel"],
      ] as const) {
        const radio = el("input", {
          type: "radio",
          name: "conflict",
          value,
          "data-testid": `conflict-${value}`,
        }) as HTMLInputElement;
        radio.checked = value === "keep-both";
        group.append(el("label", {}, radio, ` ${label}`));
      }
      this.options.append(group);
    }
    if (p.canPinOriginal) {
      const cb = el("input", { type: "checkbox", "data-testid": "import-pin" }) as HTMLInputElement;
      this.options.append(
        el("label", {}, cb, " Keep the exporter's original versions of changed core parts (pinned)"),
      );
    }
    this.importBtn.disabled = false;
  }

  private async apply(): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const choice = (this.options.querySelector("input[name=conflict]:checked") as HTMLInputElement | null)
      ?.value as ConflictChoice | undefined;
    const pin =
      (this.options.querySelector("[data-testid=import-pin]") as HTMLInputElement | null)?.checked ?? false;
    const res = await applyImport(plan, this.services.library, {
      onConflict: choice,
      pinOriginal: pin,
      newId: () => this.services.newId(),
    });
    if (!res.applied) {
      this.services.toast("Import cancelled");
      return;
    }
    await this.services.refreshCatalogue();
    const d = await this.services.library.getDesign(res.designIds[0]!);
    this.dialog.close();
    if (d) this.onLoaded(d);
    this.services.toast(
      `Imported “${d?.name ?? res.designIds[0]}”${res.partIds.length ? ` with ${res.partIds.length} part(s)` : ""}`,
    );
  }
}

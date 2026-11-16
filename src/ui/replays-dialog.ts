import { readReplay, fromJson, toJson, type ReplayData } from "../sim/scenario/record";
import { listSearch } from "./dialog-chrome";
import { el } from "./editor/dom";
import { clock } from "./report-dialog";
import type { ReplayStore } from "./replays";

/** Saves a replay as a JSON file (the browser's download). */
export function downloadReplay(r: ReplayData): void {
  const blob = new Blob([toJson(r)], { type: "application/json" });
  const a = el("a", {
    href: URL.createObjectURL(blob),
    download: `${r.title.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "battle"}-${r.createdAt.slice(0, 10)}.replay.json`,
  }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export interface ReplaysServices {
  readonly store: ReplayStore;
  readonly watch: (r: ReplayData) => void;
  readonly report: (r: ReplayData) => void;
  readonly toast: (message: string, kind?: "info" | "error") => void;
}

/** Recorded battles: watch, read the report, save to a file, load one from a file, delete. */
export class ReplaysDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;

  constructor(private readonly services: ReplaysServices) {
    this.list = el("div", { class: "lib-list", "data-testid": "replay-list" });
    const file = el("input", {
      type: "file",
      accept: ".json,application/json",
      hidden: "",
      "data-testid": "replay-file",
    }) as HTMLInputElement;
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (f) void this.load(f);
    });
    const load = el("button", { "data-testid": "replay-load" }, "Load replay file…");
    load.addEventListener("click", () => file.click());
    const close = el("button", { "data-testid": "replays-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog = el(
      "dialog",
      { class: "ed-dialog", "data-testid": "replays-dialog" },
      el("h2", {}, "Replays"),
      el(
        "p",
        { class: "dim" },
        "Every scenario, skirmish and strategy battle is recorded. The newest 20 are kept in this browser; save one as a file to keep it or share it.",
      ),
      listSearch(this.list, { testid: "replays-search", placeholder: "Search replays…" }),
      this.list,
      el("div", { class: "actions" }, load, file, close),
    ) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  private async load(f: File): Promise<void> {
    try {
      const r = readReplay(fromJson(await f.text()));
      if (!r.ok) {
        this.services.toast(r.error, "error");
        return;
      }
      await this.services.store.put(r.value);
      this.services.toast(`Loaded “${r.value.title}”`);
      await this.refresh();
    } catch {
      this.services.toast("That file could not be read as a replay.", "error");
    }
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  async open(): Promise<void> {
    await this.refresh();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private async refresh(): Promise<void> {
    const all = await this.services.store.list();
    this.list.replaceChildren();
    if (!all.length) this.list.append(el("p", { class: "dim" }, "No battles recorded yet."));
    for (const r of all) {
      const b = (label: string, id: string, f: () => void, title = "") => {
        const x = el("button", { "data-testid": `${id}-${r.id}`, title }, label);
        x.addEventListener("click", f);
        return x;
      };
      const outcome = r.status === "won" ? "victory" : r.status === "lost" ? "defeat" : "left early";
      this.list.append(
        el(
          "div",
          { class: "lib-item", "data-search": `${r.title} ${r.scenario.name} ${outcome}` },
          el("span", { class: "name" }, r.title),
          el(
            "span",
            { class: "dim" },
            `${new Date(r.createdAt).toLocaleString()} · ${outcome} · ${clock(r.endTick / 60)} · ${r.fleet.map((d) => d.name.split(" (")[0]).join(", ") || "watched"}`,
          ),
          b("Watch", "replay-watch", () => {
            this.dialog.close();
            this.services.watch(r);
          }),
          b("Report", "replay-report", () => this.services.report(r), "After-action report"),
          b("Save", "replay-save", () => downloadReplay(r), "Save as a file"),
          b(
            "✕",
            "replay-delete",
            () => {
              void this.services.store.delete(r.id).then(() => this.refresh());
            },
            "Delete",
          ),
        ),
      );
    }
  }
}

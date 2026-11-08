import type { Scenario } from "../../data/schemas/scenario";
import { SCENARIOS } from "../../data/scenarios/index";
import type { ResultStore } from "../results";
import { el } from "./dom";

export function objectiveText(s: Scenario): string {
  const o = s.objective;
  if (o.type === "survive") return `Survive ${o.seconds} s`;
  if (o.type === "protect") return "Protect the escorted ship";
  return "Destroy every enemy ship";
}

/** Scenario select (plan M7 task 2): the list in teaching order with each scenario's best result. */
export class ScenarioDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;

  constructor(
    private readonly results: ResultStore,
    private readonly onChoose: (s: Scenario) => void,
  ) {
    this.list = el("div", { class: "lib-list", "data-testid": "scenario-list" });
    const close = el("button", { "data-testid": "btn-scenarios-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog = el(
      "dialog",
      { class: "ed-dialog", "data-testid": "scenario-dialog" },
      el("h2", {}, "Scenarios"),
      this.list,
      el("div", { class: "actions" }, close),
    ) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  open(): void {
    this.list.replaceChildren();
    for (const s of SCENARIOS) {
      const best = this.results.best(s.id);
      const status = best
        ? best.won
          ? `✓ won in ${best.time.toFixed(0)} s`
          : "✗ not won yet"
        : "not played";
      const pick = el("button", { "data-testid": `scenario-${s.id}` }, "Choose");
      pick.addEventListener("click", () => {
        this.dialog.close();
        this.onChoose(s);
      });
      this.list.append(
        el(
          "div",
          { class: "lib-item" },
          el("span", { class: "name" }, `${s.order ?? ""}. ${s.name}`),
          el(
            "span",
            { class: "dim" },
            `${s.description} · ${objectiveText(s)} · budget ${s.budget}, up to ${s.maxPlayerShips} ship(s) · ${status}`,
          ),
          pick,
        ),
      );
    }
    if (!this.dialog.open) this.dialog.showModal();
  }
}

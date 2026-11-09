import type { ShipDesign } from "../../data/schemas/design";
import { STANCES, stance, stanceValues, type StanceParamKey } from "../../data/ai/stances";
import {
  checkSkirmish,
  DEFAULT_SKIRMISH,
  type SkirmishPilot,
  type SkirmishSetup,
  type SkirmishShip,
} from "../../sim/scenario/skirmish";
import { safeStorage } from "../storage";
import { el } from "./dom";

const STORE_KEY = "space-game.skirmish.v1";

/**
 * Skirmish setup (sides, ships, pilots): every ship gets a design and a pilot — the player (side 1 only)
 * or one of the four AI types with its 3–5 parameters; a defensive AI also picks the ship it guards.
 * With no player ship the battle is watched. The last setup is remembered in this browser.
 */
export class SkirmishDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly body: HTMLElement;
  private setup: { sides: [SkirmishShip[], SkirmishShip[]]; distance: number };

  constructor(
    private readonly designs: () => ShipDesign[],
    private readonly onStart: (setup: SkirmishSetup) => void,
  ) {
    this.setup = this.load();
    this.body = el("div", { class: "sk-body", "data-testid": "skirmish-body" });
    this.dialog = el(
      "dialog",
      { class: "ed-dialog sk-dialog", "data-testid": "skirmish-dialog" },
      el("h2", {}, "Skirmish"),
      this.body,
    ) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  open(): void {
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private load(): { sides: [SkirmishShip[], SkirmishShip[]]; distance: number } {
    try {
      const raw = safeStorage.get(STORE_KEY);
      if (raw) {
        const v = JSON.parse(raw) as SkirmishSetup;
        if (Array.isArray(v.sides) && v.sides.length === 2)
          return { sides: [[...v.sides[0]], [...v.sides[1]]], distance: Number(v.distance) || 5000 };
      }
    } catch {
      /* fall back to the default */
    }
    return {
      sides: [[...DEFAULT_SKIRMISH.sides[0]], [...DEFAULT_SKIRMISH.sides[1]]],
      distance: DEFAULT_SKIRMISH.distance,
    };
  }

  private save(): void {
    safeStorage.set(STORE_KEY, JSON.stringify(this.setup));
  }

  private update(side: number, i: number, ship: SkirmishShip): void {
    this.setup.sides[side]![i] = ship;
    this.save();
    this.render();
  }

  private render(): void {
    const designs = this.designs()
      .filter((d) => !d.drone)
      .sort((a, b) => a.name.localeCompare(b.name));
    const byId = new Map(designs.map((d) => [d.id, d]));
    this.body.replaceChildren();
    const sides = el("div", { class: "sk-sides" });
    this.setup.sides.forEach((side, s) => {
      const col = el(
        "div",
        { class: `sk-side side-${s}`, "data-testid": `skirmish-side-${s}` },
        el("h3", {}, s === 0 ? "Side 1 (blue)" : "Side 2 (red)"),
      );
      side.forEach((ship, i) => col.append(this.shipCard(s, i, ship, side, designs)));
      const add = el("button", { "data-testid": `skirmish-add-${s}` }, "+ Add ship");
      add.addEventListener("click", () => {
        side.push({
          designId: designs[0]?.id ?? "",
          pilot: s === 0 && side.length === 0 ? "player" : "aggressive",
        });
        this.save();
        this.render();
      });
      col.append(add);
      sides.append(col);
    });
    const dist = el("input", {
      type: "number",
      min: "1000",
      max: "20000",
      step: "500",
      value: String(this.setup.distance),
      "data-testid": "skirmish-distance",
    }) as HTMLInputElement;
    dist.addEventListener("change", () => {
      this.setup.distance = Math.min(20000, Math.max(1000, Number(dist.value) || 5000));
      this.save();
    });
    const errors = checkSkirmish(this.setup, byId);
    const players = this.setup.sides[0].filter((x) => x.pilot === "player").length;
    const start = el(
      "button",
      { class: "primary", "data-testid": "skirmish-start" },
      players ? "Start battle" : "Watch battle",
    );
    if (errors.length) start.setAttribute("disabled", "");
    start.addEventListener("click", () => {
      if (checkSkirmish(this.setup, byId).length) return;
      this.dialog.close();
      this.onStart({
        sides: [this.setup.sides[0].map((x) => ({ ...x })), this.setup.sides[1].map((x) => ({ ...x }))],
        distance: this.setup.distance,
      });
    });
    const reset = el("button", { "data-testid": "skirmish-reset" }, "Reset");
    reset.addEventListener("click", () => {
      this.setup = {
        sides: [[...DEFAULT_SKIRMISH.sides[0]], [...DEFAULT_SKIRMISH.sides[1]]],
        distance: DEFAULT_SKIRMISH.distance,
      };
      this.save();
      this.render();
    });
    const close = el("button", { "data-testid": "skirmish-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.body.append(
      el(
        "p",
        { class: "dim" },
        "Give every ship a pilot: you (side 1) or an AI type. Without a player ship you watch the battle. Tab switches between your ships.",
      ),
      sides,
      el("label", { class: "sk-dist" }, "Start distance (m) ", dist),
      ...errors.map((e) => el("div", { class: "error", "data-testid": "skirmish-error" }, e)),
      el("div", { class: "actions" }, reset, close, start),
    );
  }

  private shipCard(
    s: number,
    i: number,
    ship: SkirmishShip,
    side: SkirmishShip[],
    designs: ShipDesign[],
  ): HTMLElement {
    const id = `${s}-${i}`;
    const design = el("select", { "data-testid": `skirmish-design-${id}` }) as HTMLSelectElement;
    for (const d of designs) design.append(el("option", { value: d.id }, d.name));
    if (!designs.some((d) => d.id === ship.designId))
      design.append(el("option", { value: ship.designId }, `${ship.designId} (missing)`));
    design.value = ship.designId;
    design.addEventListener("change", () => this.update(s, i, { ...ship, designId: design.value }));

    const pilot = el("select", { "data-testid": `skirmish-pilot-${id}` }) as HTMLSelectElement;
    if (s === 0) pilot.append(el("option", { value: "player" }, "Player"));
    for (const st of STANCES) pilot.append(el("option", { value: st.id }, `AI: ${st.name}`));
    pilot.value = ship.pilot;
    pilot.addEventListener("change", () => {
      const p = pilot.value as SkirmishPilot;
      const guard = p === "defensive" ? (ship.guard ?? side.findIndex((_, k) => k !== i)) : undefined;
      this.update(s, i, {
        designId: ship.designId,
        pilot: p,
        guard: guard !== undefined && guard >= 0 ? guard : undefined,
      });
    });

    const remove = el("button", { title: "Remove ship", "data-testid": `skirmish-remove-${id}` }, "✕");
    remove.addEventListener("click", () => {
      side.splice(i, 1);
      // Guards keep pointing at the same ships.
      side.forEach((x, k) => {
        if (x.guard === undefined) return;
        const g = x.guard === i ? undefined : x.guard > i ? x.guard - 1 : x.guard;
        side[k] = { ...x, guard: g };
      });
      this.save();
      this.render();
    });

    const card = el(
      "div",
      { class: "sk-ship", "data-testid": `skirmish-ship-${id}` },
      el("div", { class: "sk-row" }, el("b", {}, `${i + 1}.`), design, remove),
      el("div", { class: "sk-row" }, el("span", {}, "Pilot"), pilot),
    );
    if (ship.pilot === "player") return card;
    const def = stance(ship.pilot);
    card.append(el("div", { class: "dim sk-desc" }, def.description));
    if (def.needsGuardTarget) {
      const guard = el("select", { "data-testid": `skirmish-guard-${id}` }) as HTMLSelectElement;
      guard.append(el("option", { value: "" }, "— pick a ship —"));
      side.forEach((x, k) => {
        if (k !== i)
          guard.append(
            el(
              "option",
              { value: String(k) },
              `${k + 1}. ${designs.find((d) => d.id === x.designId)?.name ?? x.designId}`,
            ),
          );
      });
      guard.value = ship.guard !== undefined ? String(ship.guard) : "";
      guard.addEventListener("change", () =>
        this.update(s, i, { ...ship, guard: guard.value === "" ? undefined : Number(guard.value) }),
      );
      card.append(el("div", { class: "sk-row" }, el("span", {}, "Guards"), guard));
    }
    const values = stanceValues(ship.pilot, ship.params);
    for (const p of def.params) {
      const v = values[p.key];
      const input = el("input", {
        type: "range",
        min: String(p.min),
        max: String(p.max),
        step: String(p.step),
        value: String(v),
        title: p.help,
        "data-testid": `skirmish-param-${id}-${p.key}`,
      }) as HTMLInputElement;
      const shown = (x: number) => (p.percent ? `${Math.round(x * 100)} %` : `${x}`);
      const out = el("span", { class: "sk-val" }, shown(v));
      input.addEventListener("input", () => (out.textContent = shown(Number(input.value))));
      input.addEventListener("change", () => {
        const params: Partial<Record<StanceParamKey, number>> = {
          ...ship.params,
          [p.key]: Number(input.value),
        };
        this.update(s, i, { ...ship, params });
      });
      card.append(el("label", { class: "sk-param", title: p.help }, el("span", {}, p.label), input, out));
    }
    return card;
  }
}

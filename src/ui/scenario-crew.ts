import type { ShipDesign } from "../data/schemas/design";
import type { CrewEntry, Officer, Roster } from "../data/schemas/officer";
import type { Scenario } from "../data/schemas/scenario";
import { MIXED } from "../sim/crew/names";
import { crewRng, crewSlots, officerEffects, POSITIONS, randomOfficer } from "../sim/crew/officers";
import { CLASS_LABEL } from "../sim/ship/classes";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { effectsText, officerCard, PortraitDialog, PromotionDialog, withLevel } from "./crew-ui";
import { el } from "./editor/dom";
import { portraitSvg } from "./portrait";
import { crewEntries, designClass, loadNames } from "./roster";

export interface ScenarioCrewServices {
  /** Bundled and library designs by id (the scenario editor's map). */
  designs(): ReadonlyMap<string, ShipDesign>;
  catalogue(): PartCatalogue;
  roster(): Roster;
  toast(message: string, kind?: "info" | "error"): void;
}

let counter = 0;
const newId = () => `sc-officer-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Crews of a scenario's ships, every side (docs/officers.md): generate officers (naming style, trait strength
 * and level can be fixed or random), copy a design's crew from the roster, edit an officer, or leave a ship
 * to get a random crew when the battle starts. Crews are saved in the scenario file.
 */
export class ScenarioCrewDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly officerDialog: HTMLDialogElement;
  private readonly portraits = new PortraitDialog();
  private readonly promotions = new PromotionDialog();
  private get: () => Scenario = () => {
    throw new Error("closed");
  };
  private set: (index: number, crew: CrewEntry[] | undefined) => void = () => {};
  private focus: number | undefined;
  private nameStyle = MIXED;
  /** Trait strength of generated officers: 0 = random, else 1–3 for every trait. */
  private strength = 0;
  /** Level of generated officers: 0 = random, else 1–5. */
  private level = 0;

  constructor(private readonly services: ScenarioCrewServices) {
    this.dialog = el("dialog", {
      class: "ed-dialog roster-dialog",
      "data-testid": "scenario-crew",
    }) as HTMLDialogElement;
    this.officerDialog = el("dialog", {
      class: "ed-dialog roster-dialog",
      "data-testid": "officer-dialog",
    }) as HTMLDialogElement;
    document.body.append(this.dialog, this.officerDialog);
  }

  /** Opens on the scenario `get` returns; `set` stores a ship's crew (undefined = random at start). */
  open(
    get: () => Scenario,
    set: (index: number, crew: CrewEntry[] | undefined) => void,
    focus?: number,
  ): void {
    this.get = get;
    this.set = set;
    this.focus = focus;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    if (focus !== undefined)
      this.dialog.querySelector(`[data-ship-index="${focus}"]`)?.scrollIntoView({ block: "center" });
  }

  private design(i: number): ShipDesign | undefined {
    return this.services.designs().get(this.get().enemies[i]?.designId ?? "");
  }

  private generate(i: number): CrewEntry[] | undefined {
    const d = this.design(i);
    if (!d) return undefined;
    const random = crewRng(Date.now() + i * 7919 + counter * 104729);
    const names = { style: this.nameStyle, names: loadNames() };
    return crewSlots(designClass(d, this.services.catalogue())).map((position) => {
      let o: Officer = randomOfficer(random, position, newId(), names);
      if (this.level) o = { ...o, ...withLevel({ ...o, training: [] }, this.level, random) };
      if (this.strength) o = { ...o, strength: o.traits.map(() => this.strength) };
      return { position, officer: o };
    });
  }

  private fromRoster(i: number): CrewEntry[] | undefined {
    const d = this.design(i);
    if (!d) return undefined;
    const crew = crewEntries(this.services.roster(), d, this.services.catalogue());
    return crew.length ? structuredClone(crew) : undefined;
  }

  private apply(indices: number[], make: (i: number) => CrewEntry[] | undefined): void {
    for (const i of indices) this.set(i, make(i));
    this.render();
  }

  private render(): void {
    const s = this.get();
    const cat = this.services.catalogue();
    // Generation settings.
    const style = el("select", {
      "aria-label": "Name style",
      "data-testid": "sc-crew-names",
    }) as HTMLSelectElement;
    style.append(el("option", { value: MIXED }, "Mixed"));
    for (const st of loadNames().styles) style.append(el("option", { value: st.id }, st.label));
    style.value = this.nameStyle;
    style.addEventListener("change", () => (this.nameStyle = style.value));
    const strength = el("select", {
      "aria-label": "Trait strength",
      "data-testid": "sc-crew-strength",
    }) as HTMLSelectElement;
    for (const [v, label] of [
      [0, "Random"],
      [1, "Small"],
      [2, "Medium"],
      [3, "Full"],
    ] as const)
      strength.append(el("option", { value: String(v) }, label));
    strength.value = String(this.strength);
    strength.addEventListener("change", () => (this.strength = Number(strength.value)));
    const level = el("select", {
      "aria-label": "Level",
      "data-testid": "sc-crew-level",
    }) as HTMLSelectElement;
    level.append(el("option", { value: "0" }, "Random"));
    for (let k = 1; k <= 5; k++) level.append(el("option", { value: String(k) }, `Level ${k}`));
    level.value = String(this.level);
    level.addEventListener("change", () => (this.level = Number(level.value)));

    const sides = el("div", { class: "sc-crew-sides" });
    const teams = [...new Set(s.enemies.map((e) => e.team))].sort((a, b) => a - b);
    for (const team of teams) {
      const idx = s.enemies.flatMap((e, i) => (e.team === team ? [i] : []));
      const gen = el("button", { "data-testid": `sc-crew-gen-team-${team}` }, "Generate crews");
      gen.addEventListener("click", () => this.apply(idx, (i) => this.generate(i)));
      const ros = el("button", { title: "Each design's crew from the roster" }, "Roster crews");
      ros.addEventListener("click", () => this.apply(idx, (i) => this.fromRoster(i)));
      const clr = el("button", { title: "Random officers when the battle starts" }, "Random at start");
      clr.addEventListener("click", () => this.apply(idx, () => undefined));
      const block = el(
        "section",
        { class: "roster-ship" },
        el(
          "div",
          { class: "roster-top" },
          el("b", {}, team === 0 ? "Team 0 (your side)" : `Team ${team} (enemy)`),
          gen,
          ros,
          clr,
        ),
      );
      for (const i of idx) block.append(this.shipRow(s, i, cat));
      sides.append(block);
    }
    if (!teams.length) sides.append(el("p", { class: "dim" }, "Place ships first."));
    const close = el("button", { "data-testid": "sc-crew-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog.replaceChildren(
      el("h2", {}, "Crews"),
      el(
        "p",
        { class: "dim" },
        "Officers of every ship in this scenario, saved with it. Ships without a crew get random officers when the battle starts (team 0: the roster's crew of the design, if any).",
      ),
      el(
        "div",
        { class: "roster-top" },
        el("label", {}, "Names ", style),
        el("label", {}, "Trait strength ", strength),
        el("label", {}, "Level ", level),
      ),
      sides,
      el("div", { class: "actions" }, close),
    );
  }

  private shipRow(s: Scenario, i: number, cat: PartCatalogue): HTMLElement {
    const e = s.enemies[i]!;
    const d = this.services.designs().get(e.designId);
    const cls = d ? designClass(d, cat) : null;
    const slots = cls ? crewSlots(cls) : [];
    const head = el(
      "div",
      { class: "roster-line" },
      el("b", {}, `${i + 1}. ${d?.name ?? `unknown design ${e.designId}`}`),
      el("span", { class: "dim" }, cls ? `${CLASS_LABEL[cls]}, ${slots.length} post(s)` : ""),
    );
    const row = el(
      "div",
      { class: `sc-crew-ship${this.focus === i ? " focus" : ""}`, "data-ship-index": String(i) },
      head,
    );
    if (!d || !slots.length) {
      row.append(el("span", { class: "dim" }, d ? "No officers (drone)." : "Unknown design: no crew."));
      return row;
    }
    const gen = el("button", { "data-testid": `sc-crew-gen-${i}` }, "Generate");
    gen.addEventListener("click", () => this.apply([i], (k) => this.generate(k)));
    const ros = el("button", {}, "From roster");
    ros.addEventListener("click", () => {
      const c = this.fromRoster(i);
      if (!c) this.services.toast(`The roster has no crew for ${d.name}`);
      this.apply([i], () => c);
    });
    const clr = el("button", {}, "Random at start");
    clr.addEventListener("click", () => this.apply([i], () => undefined));
    head.append(gen, ros, clr);
    const crew = e.crew ?? [];
    if (!crew.length) {
      row.append(
        el("span", { class: "dim", "data-testid": `sc-crew-none-${i}` }, "Random officers at the start."),
      );
      return row;
    }
    const cards = el("div", { class: "crew-strip sc-crew-cards" });
    for (const c of crew) {
      if (!slots.includes(c.position)) continue;
      const face = el("span", { class: "crew-face" });
      face.innerHTML = portraitSvg(c.officer.portrait, 34, c.officer.level);
      const card = el(
        "button",
        {
          class: "crew-card",
          title: "Edit this officer",
          "data-testid": `sc-crew-officer-${i}-${c.position}`,
        },
        face,
        el(
          "span",
          { class: "crew-text" },
          el("b", {}, c.officer.name),
          el("span", { class: "dim" }, `${POSITIONS[c.position].label} · level ${c.officer.level}`),
          el(
            "span",
            { class: "crew-fx" },
            effectsText(officerEffects(c.officer, c.position), 3) || "no effect",
          ),
        ),
      );
      card.addEventListener("click", () => this.editOfficer(i, c.position));
      cards.append(card);
    }
    row.append(cards);
    return row;
  }

  /** One officer of a ship in the full editor (portrait, name, level, traits, training). */
  private editOfficer(i: number, position: CrewEntry["position"]): void {
    const render = () => {
      const crew = this.get().enemies[i]?.crew ?? [];
      const entry = crew.find((c) => c.position === position);
      if (!entry) return this.officerDialog.close();
      const card = officerCard(entry.officer, {
        portraits: this.portraits,
        promotions: this.promotions,
        nameStyle: () => this.nameStyle,
        update: (patch) => {
          this.set(
            i,
            crew.map((c) => (c.position === position ? { ...c, officer: { ...c.officer, ...patch } } : c)),
          );
          render();
          this.render();
        },
      });
      const close = el("button", { "data-testid": "officer-close" }, "Done");
      close.addEventListener("click", () => this.officerDialog.close());
      this.officerDialog.replaceChildren(
        el("h2", {}, `${POSITIONS[position].label}: ${this.design(i)?.name ?? ""}`),
        card,
        el("div", { class: "actions" }, close),
      );
    };
    render();
    if (!this.officerDialog.open) this.officerDialog.showModal();
  }
}

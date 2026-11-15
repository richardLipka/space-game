import { listSearch } from "./dialog-chrome";
import type { ShipDesign } from "../data/schemas/design";
import type { Officer, PortraitSpec, Position, Roster } from "../data/schemas/officer";
import { validateNames } from "../data/validate";
import { repairOfficer, repairRoster } from "../data/repair";
import { generateName, MIXED } from "../sim/crew/names";
import { designSection, orderSections } from "../data/designs/index";
import {
  crewRng,
  crewSlots,
  MAX_LEVEL,
  migratePortrait,
  promote,
  promotionOptions,
  suggestedAi,
  levelUpStat,
  officerEffects,
  POSITIONS,
  STRENGTH_LABEL,
  TRAINING_PCT,
  trainingOf,
  UNIFORM_STYLES,
  type UniformStyle,
  randomPortrait,
  shipMods,
  STAT_LABEL,
  STATS,
  type Stat,
  trait,
  TRAITS,
} from "../sim/crew/officers";
import { AI_PROFILES } from "../data/ai/index";
import { CLASS_LABEL } from "../sim/ship/classes";
import type { PartCatalogue } from "../sim/ship/catalogue";
import type { CrewMember, Ship } from "../sim/ship/ship-entity";
import { el } from "./editor/dom";
import { hullFraction } from "./hud/ship-plan";
import {
  accessoriesOf,
  chevronsSvg,
  PART_LABELS,
  portraitSvg,
  UNIFORM_STYLE_LABELS,
  withAccessories,
} from "./portrait";
import {
  crewOf,
  designClass,
  emptyRoster,
  freshOfficer,
  generateCrew,
  loadNames,
  saveNames,
  saveRoster,
} from "./roster";

/** "+5% gun damage, −3% turning" for the largest effects. */
export function effectsText(effects: Partial<Record<Stat, number>>, max = 4): string {
  return (Object.entries(effects) as [Stat, number][])
    .filter(([, v]) => Math.abs(v) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, max)
    .map(([s, v]) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}% ${STAT_LABEL[s].toLowerCase()}`)
    .join(", ");
}

/** Level as text where markup cannot go (select options): "Lv 3". */
const lv = (n: number) => `Lv ${n}`;

// ---------- portrait dialog ----------

/** Combines portrait parts: arrows per part, space suit, randomise; Apply hands the spec back. */
export class PortraitDialog {
  private readonly dialog: HTMLDialogElement;
  private spec: PortraitSpec = randomPortrait(crewRng(1));
  private onApply: ((p: PortraitSpec) => void) | null = null;
  private level: number | undefined;

  constructor() {
    this.dialog = el("dialog", {
      class: "ed-dialog portrait-dialog",
      "data-testid": "portrait-dialog",
    }) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  open(spec: PortraitSpec, onApply: (p: PortraitSpec) => void, level?: number): void {
    this.spec = migratePortrait(spec);
    this.level = level;
    this.onApply = onApply;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private render(): void {
    const preview = el("div", { class: "portrait-preview", "data-testid": "portrait-preview" });
    preview.innerHTML = portraitSvg(this.spec, 180, this.level);
    const rows = el("div", { class: "portrait-parts" });
    // Uniform style: uniform, cap, collar and colour in one pick.
    const style = el("select", {
      "data-testid": "portrait-style",
      "aria-label": "Uniform style",
    }) as HTMLSelectElement;
    style.append(el("option", { value: "" }, "Custom"));
    for (const [id, label] of Object.entries(UNIFORM_STYLE_LABELS))
      style.append(el("option", { value: id }, label));
    const current = (
      Object.entries(UNIFORM_STYLES) as [UniformStyle, (typeof UNIFORM_STYLES)[UniformStyle]][]
    ).find(([, st]) => st.uniform === this.spec.uniform && st.collar === this.spec.collar);
    style.value = current?.[0] ?? "";
    style.addEventListener("change", () => {
      const st = UNIFORM_STYLES[style.value as UniformStyle];
      if (st) this.spec = { ...this.spec, ...st, suit: false };
      this.render();
    });
    rows.append(
      el(
        "label",
        { class: "portrait-row portrait-style" },
        el("span", { class: "dim" }, "uniform style"),
        style,
      ),
    );
    for (const key of (Object.keys(PART_LABELS) as (keyof typeof PART_LABELS)[]).filter(
      (k) => k !== "accessory",
    )) {
      const labels = PART_LABELS[key];
      const set = (v: number) => {
        this.spec = { ...this.spec, [key]: ((v % labels.length) + labels.length) % labels.length };
        this.render();
      };
      const value = ((this.spec[key] % labels.length) + labels.length) % labels.length;
      const prev = el("button", { "data-testid": `portrait-${key}-prev`, title: "Previous" }, "◀");
      prev.addEventListener("click", () => set(value - 1));
      const next = el("button", { "data-testid": `portrait-${key}-next`, title: "Next" }, "▶");
      next.addEventListener("click", () => set(value + 1));
      // The same choice as a list.
      const pick = el("select", {
        class: "portrait-value",
        "data-testid": `portrait-${key}`,
        "aria-label": key,
      }) as HTMLSelectElement;
      labels.forEach((l, i) => pick.append(el("option", { value: String(i) }, l)));
      pick.value = String(value);
      pick.addEventListener("change", () => set(Number(pick.value)));
      rows.append(
        el(
          "div",
          { class: "portrait-row" },
          el("span", { class: "dim" }, key.replace(/([A-Z])/g, " $1").toLowerCase()),
          prev,
          pick,
          next,
        ),
      );
    }
    // Accessories: any number together.
    const worn = new Set(accessoriesOf(this.spec));
    const acc = el("div", { class: "portrait-accessories", "data-testid": "portrait-accessories" });
    PART_LABELS.accessory.forEach((label, i) => {
      if (i === 0) return;
      const box = el("input", { type: "checkbox", "data-testid": `portrait-acc-${i}` }) as HTMLInputElement;
      box.checked = worn.has(i);
      box.addEventListener("change", () => {
        const list = accessoriesOf(this.spec).filter((a) => a !== i);
        if (box.checked) list.push(i);
        this.spec = withAccessories(this.spec, list);
        this.render();
      });
      acc.append(el("label", {}, box, ` ${label}`));
    });
    rows.append(el("div", { class: "dim" }, "accessories"), acc);
    const suit = el("input", { type: "checkbox", "data-testid": "portrait-suit" }) as HTMLInputElement;
    suit.checked = this.spec.suit;
    suit.addEventListener("change", () => {
      this.spec = { ...this.spec, suit: suit.checked };
      this.render();
    });
    rows.append(el("label", { class: "portrait-row" }, suit, " Space suit"));
    const random = el("button", { "data-testid": "portrait-random" }, "Randomise");
    random.addEventListener("click", () => {
      this.spec = randomPortrait(crewRng(Date.now()));
      this.render();
    });
    const apply = el("button", { "data-testid": "portrait-apply" }, "Apply");
    apply.addEventListener("click", () => {
      this.onApply?.(this.spec);
      this.dialog.close();
    });
    const cancel = el("button", {}, "Cancel");
    cancel.addEventListener("click", () => this.dialog.close());
    this.dialog.replaceChildren(
      el("h2", {}, "Portrait"),
      el("div", { class: "portrait-editor" }, preview, rows),
      el("div", { class: "actions" }, random, apply, cancel),
    );
  }
}

// ---------- roster dialog ----------

export interface RosterServices {
  roster(): Roster;
  setRoster(r: Roster): void;
  designs(): Promise<ShipDesign[]>;
  catalogue(): PartCatalogue;
  toast(message: string, kind?: "info" | "error"): void;
}

/**
 * Officers and their posts: pick a ship design, fill its posts (by class) from the roster or generate a
 * crew, and edit officers (name, post, level, traits, portrait). The roster exports and imports as JSON.
 */
export class RosterDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly portraits = new PortraitDialog();
  private readonly promotions = new PromotionDialog();
  private readonly officerDialog = new OfficerDialog(() => this.nameStyle);
  private designs: ShipDesign[] = [];
  private designId = "";
  /** Naming style for generated officers ("mixed" or a style id). */
  private nameStyle = MIXED;
  /** Officer search text (kept while the dialog rebuilds). */
  private query = "";

  private names() {
    return { style: this.nameStyle, names: loadNames() };
  }

  constructor(private readonly services: RosterServices) {
    this.dialog = el("dialog", {
      class: "ed-dialog roster-dialog",
      "data-testid": "roster-dialog",
    }) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  async open(designId?: string): Promise<void> {
    this.designs = (await this.services.designs()).filter((d) => !d.drone);
    this.designId =
      designId && this.designs.some((d) => d.id === designId) ? designId : (this.designs[0]?.id ?? "");
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private save(r: Roster): void {
    saveRoster(r);
    this.services.setRoster(r);
    this.render();
  }

  private render(): void {
    const r = this.services.roster();
    const cat = this.services.catalogue();
    const design = this.designs.find((d) => d.id === this.designId);
    // Ship picker, grouped by library section.
    const pick = el("select", { "data-testid": "roster-ship" }) as HTMLSelectElement;
    const by = new Map<string, ShipDesign[]>();
    for (const d of this.designs) by.set(designSection(d), [...(by.get(designSection(d)) ?? []), d]);
    for (const s of orderSections(by.keys())) {
      const g = el("optgroup", { label: s });
      for (const d of by.get(s)!) g.append(el("option", { value: d.id }, d.name));
      pick.append(g);
    }
    pick.value = this.designId;
    pick.addEventListener("change", () => {
      this.designId = pick.value;
      this.render();
    });
    const ship = el("section", { class: "roster-ship" });
    if (design) {
      const cls = designClass(design, cat);
      const slots = crewSlots(cls);
      const crew = crewOf(r, design.id, cls);
      ship.append(
        el(
          "p",
          { class: "dim" },
          `${CLASS_LABEL[cls]}: ${slots.length ? `${slots.length} post(s)` : "no officers (drone)"}`,
        ),
      );
      const assigned = new Set(Object.values(r.crews).flatMap((c) => Object.values(c)));
      for (const position of slots) {
        const holder = crew.find((c) => c.position === position)?.officer;
        const sel = el("select", { "data-testid": `roster-post-${position}` }) as HTMLSelectElement;
        sel.append(el("option", { value: "" }, "— empty —"));
        for (const o of r.officers)
          if (o.id === holder?.id || !assigned.has(o.id))
            sel.append(
              el("option", { value: o.id }, `${o.name} (${POSITIONS[o.position].label}, ${lv(o.level)})`),
            );
        sel.value = holder?.id ?? "";
        sel.addEventListener("change", () => {
          const posts = { ...(r.crews[design.id] ?? {}) };
          if (sel.value) posts[position] = sel.value;
          else delete posts[position];
          this.save({ ...r, crews: { ...r.crews, [design.id]: posts } });
        });
        const face = el("span", { class: "roster-face" });
        if (holder) face.innerHTML = portraitSvg(holder.portrait, 36, holder.level);
        const edit = el(
          "button",
          { "data-testid": `roster-edit-${position}`, title: "Edit this officer" },
          "Edit…",
        ) as HTMLButtonElement;
        edit.disabled = !holder;
        edit.addEventListener("click", () => {
          if (!holder) return;
          this.officerDialog.open(
            holder,
            (o) => {
              const cur = this.services.roster();
              this.save({ ...cur, officers: cur.officers.map((x) => (x.id === o.id ? o : x)) });
            },
            `${POSITIONS[position].label}: ${design.name}`,
          );
        });
        ship.append(
          el(
            "div",
            { class: "roster-post" },
            face,
            el("b", {}, POSITIONS[position].label),
            sel,
            edit,
            el("span", { class: "dim" }, holder ? effectsText(officerEffects(holder, position)) : ""),
          ),
        );
      }
      if (slots.length) {
        const m = shipMods(crew);
        const total = Object.fromEntries(STATS.map((s) => [s, Math.round((m[s] - 1) * 1000) / 10])) as Record<
          Stat,
          number
        >;
        ship.append(el("p", {}, el("b", {}, "Ship: "), effectsText(total, 9) || "no effect"));
        const gen = el("button", { "data-testid": "roster-generate" }, "Generate crew for empty posts");
        gen.addEventListener("click", () =>
          this.save(generateCrew(structuredClone(r), design.id, cls, Date.now(), this.names())),
        );
        ship.append(gen);
      }
    }
    const genAll = el("button", { "data-testid": "roster-generate-all" }, "Generate crews for every ship");
    genAll.addEventListener("click", () => {
      const next = structuredClone(r);
      this.designs.forEach((d, i) =>
        generateCrew(next, d.id, designClass(d, cat), Date.now() + i * 7919, this.names()),
      );
      this.save(next);
      this.services.toast("Crews generated for every ship without a full crew");
    });

    // Officers.
    const list = el("div", { class: "roster-officers", "data-testid": "roster-officers" });
    for (const o of r.officers) list.append(this.officerCard(r, o));
    const add = el("button", { "data-testid": "roster-new" }, "New officer");
    add.addEventListener("click", () =>
      this.save({ ...r, officers: [...r.officers, freshOfficer("captain", undefined, this.names())] }),
    );
    const exp = el("button", { "data-testid": "roster-export" }, "Export JSON");
    exp.addEventListener("click", () => {
      const a = el("a", {
        href: URL.createObjectURL(
          new Blob([`${JSON.stringify(r, null, 2)}\n`], { type: "application/json" }),
        ),
        download: "roster.json",
      }) as HTMLAnchorElement;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const file = el("input", {
      type: "file",
      accept: ".json,application/json",
      hidden: "",
    }) as HTMLInputElement;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        // A roster file, or a single officer (added to the roster); whatever does not fit this version is
        // repaired (unknown traits replaced, broken posts dropped) and reported.
        let notes: string[];
        if (data && typeof data === "object" && "officers" in data) {
          const rep = repairRoster(data);
          notes = rep.notes;
          this.save(rep.roster);
        } else {
          const one = repairOfficer(data);
          if (!one.officer) throw new Error(one.notes[0] ?? "not a roster or an officer");
          const off = one.officer;
          notes = one.notes;
          this.save({ ...r, officers: [...r.officers.filter((x) => x.id !== off.id), off] });
        }
        if (notes.length)
          this.services.toast(`Imported with changes: ${notes.slice(0, 3).join(" ")}`, "error");
        this.services.toast("Roster imported");
      } catch (e) {
        this.services.toast(`Cannot import: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    });
    const imp = el("button", { "data-testid": "roster-import" }, "Import JSON");
    imp.addEventListener("click", () => file.click());
    const clear = el("button", { class: "danger" }, "Clear roster");
    clear.addEventListener("click", () => {
      if (confirm("Remove every officer and post? This cannot be undone.")) this.save(emptyRoster());
    });
    // Naming style for new officers, and the name descriptor (bundled, or an imported file).
    const desc = loadNames();
    const style = el("select", {
      "data-testid": "roster-name-style",
      "aria-label": "Name style",
    }) as HTMLSelectElement;
    style.append(el("option", { value: MIXED }, "Mixed"));
    for (const s of desc.styles) style.append(el("option", { value: s.id }, s.label));
    style.value = desc.styles.some((s) => s.id === this.nameStyle) ? this.nameStyle : MIXED;
    style.addEventListener("change", () => (this.nameStyle = style.value));
    const namesFile = el("input", {
      type: "file",
      accept: ".json,application/json",
      hidden: "",
    }) as HTMLInputElement;
    namesFile.addEventListener("change", async () => {
      const f = namesFile.files?.[0];
      if (!f) return;
      try {
        const v = validateNames(JSON.parse(await f.text()));
        if (!v.ok) throw new Error(v.errors[0]);
        saveNames(v.value);
        this.services.toast(`Name styles imported: ${v.value.styles.map((s) => s.label).join(", ")}`);
        this.render();
      } catch (e) {
        this.services.toast(`Cannot import names: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    });
    const namesImp = el(
      "button",
      { "data-testid": "roster-names-import", title: "A name descriptor file (docs/officers.md)" },
      "Import names…",
    );
    namesImp.addEventListener("click", () => namesFile.click());
    const namesReset = el(
      "button",
      { title: "Back to the bundled English, German and Japanese names" },
      "Default names",
    );
    namesReset.addEventListener("click", () => {
      saveNames(null);
      this.render();
    });
    const close = el("button", { "data-testid": "roster-close" }, "Close");
    close.addEventListener("click", () => this.dialog.close());
    this.dialog.replaceChildren(
      el("h2", {}, "Crew roster"),
      el("div", { class: "roster-top" }, el("label", {}, "Ship ", pick), genAll),
      el("div", { class: "roster-top" }, el("label", {}, "Names ", style), namesImp, namesFile, namesReset),
      ship,
      el(
        "div",
        { class: "roster-top" },
        el("h3", {}, `Officers (${r.officers.length})`),
        listSearch(list, {
          testid: "roster-search",
          placeholder: "Search name, post, trait…",
          value: this.query,
          onChange: (q) => (this.query = q),
        }),
      ),
      list,
      el("div", { class: "actions" }, add, exp, imp, file, clear, close),
    );
  }

  private officerCard(r: Roster, o: Officer): HTMLElement {
    return officerCard(o, {
      portraits: this.portraits,
      promotions: this.promotions,
      nameStyle: () => this.nameStyle,
      update: (patch) =>
        this.save({ ...r, officers: r.officers.map((x) => (x.id === o.id ? { ...x, ...patch } : x)) }),
      remove: () => {
        const crews = Object.fromEntries(
          Object.entries(r.crews).map(([d, posts]) => [
            d,
            Object.fromEntries(Object.entries(posts).filter(([, id]) => id !== o.id)),
          ]),
        );
        this.save({ ...r, officers: r.officers.filter((x) => x.id !== o.id), crews });
      },
    });
  }
}

// ---------- crew strip (strategy and flight) ----------

/** Hull fraction below which the crew strip shows every officer in a space suit. */
export const SUIT_BELOW = 0.5;

/**
 * The officers of a ship along the bottom of the screen: portrait, post, experience and what they add. Below
 * half hull ({@link SUIT_BELOW}) they are all drawn in space suits.
 */
export class CrewStrip {
  readonly el: HTMLElement;
  private key = "";

  constructor(testid: string) {
    this.el = el("div", { class: "crew-strip", "data-testid": testid, hidden: "" });
  }

  update(ship: Ship | null): void {
    const crew: readonly CrewMember[] = ship?.crew ?? [];
    // Below half hull the whole crew is in space suits.
    const suited = !!ship && hullFraction(ship) < SUIT_BELOW;
    const key = ship ? `${ship.id}|${suited ? "s" : ""}|${crew.map((c) => c.officer.id).join(",")}` : "";
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = !crew.length;
    this.el.classList.toggle("crew-suited", suited);
    if (!crew.length || !ship) return this.el.replaceChildren();
    const cards = crew.map((c) => {
      const face = el("span", { class: "crew-face" });
      const portrait = suited ? { ...c.officer.portrait, suit: true } : c.officer.portrait;
      face.innerHTML = portraitSvg(portrait, 40, c.officer.level);
      const fx = officerEffects(c.officer, c.position);
      const traitNames = c.officer.traits.map((id) => trait(id)?.name ?? id);
      return el(
        "div",
        {
          class: "crew-card",
          title: `${c.officer.name}\n${traitNames.slice(0, 3).join(", ")}\n(−) ${traitNames.slice(3).join(", ")}\n${effectsText(fx, 9)}`,
        },
        face,
        el(
          "div",
          { class: "crew-text" },
          el("b", {}, c.officer.name),
          (() => {
            const rank = el("span", { class: "dim crew-rank" }, `${POSITIONS[c.position].label} `);
            rank.insertAdjacentHTML("beforeend", chevronsSvg(c.officer.level, 14));
            return rank;
          })(),
          el("span", { class: "crew-fx" }, effectsText(fx, 3) || "no effect"),
        ),
      );
    });
    const totals = Object.fromEntries(
      STATS.map((s) => [s, Math.round((ship.mods[s] - 1) * 1000) / 10]),
    ) as Record<Stat, number>;
    this.el.replaceChildren(
      ...cards,
      el(
        "div",
        { class: "crew-total", title: effectsText(totals, 9) },
        el("b", {}, "Ship"),
        el("span", { class: "crew-fx" }, effectsText(totals, 3) || "no effect"),
      ),
    );
  }
}

// ---------- officer editor (roster, scenario crews) ----------

export interface OfficerCardOptions {
  readonly portraits: PortraitDialog;
  /** With it, a "Level up…" button promotes the officer through the dialog. */
  readonly promotions?: PromotionDialog;
  /** Naming style for a new name when the officer's own is unknown. */
  readonly nameStyle: () => string;
  update(patch: Partial<Officer>): void;
  remove?(): void;
}

/** The officer with a level changed: one trained stat added per level gained, the last ones dropped per level lost. */
export function withLevel(
  o: Officer,
  level: number,
  random: () => number = crewRng(Date.now()),
): Partial<Officer> {
  const training = trainingOf(o);
  while (training.length < level - 1) training.push(levelUpStat(random, o.position));
  return { level, training: training.slice(0, level - 1) };
}

/**
 * One officer, editable: portrait (opens the portrait editor), name (⟳ draws a new one), trained post, level
 * (each level trains one stat, changeable), traits with their strength (small, medium, full), and what the
 * officer adds at the trained post.
 */
export function officerCard(o: Officer, opts: OfficerCardOptions): HTMLElement {
  const update = opts.update;
  const face = el("button", {
    class: "roster-portrait",
    title: "Edit portrait",
    "data-testid": `roster-portrait-${o.id}`,
  });
  face.innerHTML = portraitSvg(o.portrait, 56, o.level);
  face.addEventListener("click", () =>
    opts.portraits.open(o.portrait, (p) => update({ portrait: p }), o.level),
  );
  const name = el("input", { value: o.name, class: "roster-name", "aria-label": "Name" }) as HTMLInputElement;
  name.addEventListener("change", () => update({ name: name.value.trim() || o.name }));
  const reroll = el(
    "button",
    { title: "New name in this officer's style", "data-testid": `roster-reroll-${o.id}` },
    "⟳",
  );
  reroll.addEventListener("click", () => {
    const desc = loadNames();
    const style = o.origin && desc.styles.some((x) => x.id === o.origin) ? o.origin : opts.nameStyle();
    update(generateName(crewRng(Date.now()), style, desc));
  });
  const pos = el("select", { "aria-label": "Trained for" }) as HTMLSelectElement;
  for (const p of Object.values(POSITIONS)) pos.append(el("option", { value: p.id }, p.label));
  pos.value = o.position;
  pos.addEventListener("change", () => update({ position: pos.value as Position }));
  const lvl = el("select", {
    "aria-label": "Experience",
    "data-testid": `officer-level-${o.id}`,
  }) as HTMLSelectElement;
  for (let i = 1; i <= 5; i++) lvl.append(el("option", { value: String(i) }, `Level ${i}`));
  lvl.value = String(o.level);
  lvl.addEventListener("change", () => update(withLevel(o, Number(lvl.value))));
  // Traits: three positive, two negative, each with its strength.
  const traits = el("div", { class: "roster-traits" });
  const strength = o.strength ?? [3, 3, 3, 3, 3];
  o.traits.forEach((id, i) => {
    const positive = i < 3;
    const sel = el("select", {
      class: positive ? "good" : "bad",
      "aria-label": positive ? "Positive trait" : "Negative trait",
    }) as HTMLSelectElement;
    for (const t of TRAITS.filter((x) => x.positive === positive))
      if (t.id === id || !o.traits.includes(t.id))
        sel.append(
          el(
            "option",
            { value: t.id, title: effectsText(t.effects) },
            `${t.name} (${effectsText(t.effects)})`,
          ),
        );
    sel.value = id;
    sel.addEventListener("change", () =>
      update({ traits: o.traits.map((x, k) => (k === i ? sel.value : x)) }),
    );
    const st = el("select", {
      class: "roster-strength",
      "aria-label": "Strength",
      title: "Strength of the trait: small (⅓), medium (⅔) or full",
      "data-testid": `officer-strength-${o.id}-${i}`,
    }) as HTMLSelectElement;
    for (let k = 1; k <= 3; k++) st.append(el("option", { value: String(k) }, STRENGTH_LABEL[k]!));
    st.value = String(strength[i] ?? 3);
    st.addEventListener("change", () =>
      update({ strength: strength.map((x, k) => (k === i ? Number(st.value) : x)) }),
    );
    traits.append(el("span", { class: "roster-trait" }, sel, st));
  });
  // Training: one stat per level above the first.
  const training = el("div", { class: "roster-training" });
  const trained = trainingOf(o);
  if (trained.length) training.append(el("span", { class: "dim" }, "Trained: "));
  trained.forEach((stat, i) => {
    const sel = el("select", {
      "aria-label": `Level ${i + 2} training`,
      title: `What level ${i + 2} trained (+${TRAINING_PCT}% before post emphasis)`,
    }) as HTMLSelectElement;
    for (const x of STATS) sel.append(el("option", { value: x }, `+${STAT_LABEL[x].toLowerCase()}`));
    sel.value = stat;
    sel.addEventListener("change", () =>
      update({ training: trained.map((x, k) => (k === i ? (sel.value as Stat) : x)) }),
    );
    training.append(sel);
  });
  // Default AI (optional): what the officer flies by when the ship is under AI control and they command it.
  const suggested = suggestedAi(o);
  const ai = el("select", {
    "aria-label": "Default AI",
    title: "AI profile when this officer commands an AI-flown ship (optional)",
    "data-testid": `officer-ai-${o.id}`,
  }) as HTMLSelectElement;
  ai.append(
    el("option", { value: "" }, `AI: default (suggested ${AI_PROFILES.get(suggested)?.name ?? suggested})`),
  );
  for (const p of AI_PROFILES.values())
    ai.append(el("option", { value: p.id }, `AI: ${p.name}${p.id === suggested ? " ★" : ""}`));
  ai.value = o.ai && AI_PROFILES.has(o.ai) ? o.ai : "";
  ai.addEventListener("change", () => update({ ai: ai.value || undefined }));
  const line = el("div", { class: "roster-line" }, name, reroll, pos, lvl, ai);
  if (opts.promotions && o.level < MAX_LEVEL) {
    const up = el(
      "button",
      { "data-testid": `officer-promote-${o.id}`, title: "Gain a level and pick what it trains" },
      "▲ Level up…",
    );
    up.addEventListener("click", () =>
      opts.promotions!.open(o, (p) => update({ level: p.level, training: p.training })),
    );
    line.append(up);
  }
  if (opts.remove) {
    const del = el("button", { class: "danger", title: "Remove the officer" }, "✕");
    del.addEventListener("click", () => opts.remove!());
    line.append(del);
  }
  const own = officerEffects(o, o.position);
  return el(
    "div",
    {
      class: "roster-officer",
      "data-officer": o.id,
      "data-search": [
        o.name,
        POSITIONS[o.position].label,
        `level ${o.level}`,
        ...o.traits.map((id) => trait(id)?.name ?? id),
      ].join(" "),
    },
    face,
    el(
      "div",
      { class: "roster-officer-body" },
      line,
      traits,
      training,
      el(
        "div",
        { class: "dim" },
        `As ${POSITIONS[o.position].label.toLowerCase()}: ${effectsText(own, 6) || "no effect"}`,
      ),
    ),
  );
}

// ---------- promotion and officer dialogs ----------

/**
 * Promotion (campaigns, the roster): an officer gains a level and you pick what it trains. Each stat shows
 * what it adds at the officer's post; the post's own stats count more. `onPromote` gets the promoted officer.
 */
export class PromotionDialog {
  private readonly dialog: HTMLDialogElement;

  constructor() {
    this.dialog = el("dialog", {
      class: "ed-dialog promotion-dialog",
      "data-testid": "promotion-dialog",
    }) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  open(o: Officer, onPromote: (promoted: Officer) => void, position: Position = o.position): void {
    const post = POSITIONS[position];
    const head = el("div", { class: "promotion-head" });
    const face = el("span", { class: "promotion-face" });
    face.innerHTML = portraitSvg(o.portrait, 72, Math.min(MAX_LEVEL, o.level + 1));
    head.append(face);
    if (o.level >= MAX_LEVEL) {
      head.append(el("p", {}, el("b", {}, o.name), ` is at level ${MAX_LEVEL}, the highest.`));
      const ok = el("button", { "data-testid": "promotion-cancel" }, "Close");
      ok.addEventListener("click", () => this.dialog.close());
      this.dialog.replaceChildren(el("h2", {}, "Promotion"), head, el("div", { class: "actions" }, ok));
      if (!this.dialog.open) this.dialog.showModal();
      return;
    }
    const options = promotionOptions(position);
    let chosen: Stat = options[0]!.stat;
    const now = el("p", { class: "dim" });
    const after = el("p", { "data-testid": "promotion-after" });
    const update = () => {
      now.textContent = `Now (level ${o.level}): ${effectsText(officerEffects(o, position), 9) || "no effect"}`;
      const next = promote(o, chosen)!;
      after.textContent = `After (level ${next.level}): ${effectsText(officerEffects(next, position), 9) || "no effect"}`;
      for (const r of list.querySelectorAll<HTMLInputElement>("input[type=radio]"))
        r.checked = r.value === chosen;
    };
    const list = el("div", { class: "promotion-options", role: "radiogroup", "aria-label": "Training" });
    for (const opt of options) {
      const radio = el("input", {
        type: "radio",
        name: "promotion-stat",
        value: opt.stat,
        "data-testid": `promotion-${opt.stat}`,
      }) as HTMLInputElement;
      radio.addEventListener("change", () => {
        chosen = opt.stat;
        update();
      });
      list.append(
        el(
          "label",
          { class: `promotion-option${opt.focus ? " focus" : ""}` },
          radio,
          ` +${opt.gain.toFixed(1)}% ${STAT_LABEL[opt.stat].toLowerCase()}`,
          opt.focus ? el("span", { class: "dim" }, ` · ${post.label.toLowerCase()} stat`) : "",
        ),
      );
    }
    const random = el(
      "button",
      {
        "data-testid": "promotion-random",
        title: "As levels are gained in battle: the post's stats are likelier",
      },
      "Random",
    );
    random.addEventListener("click", () => {
      chosen = levelUpStat(crewRng(Date.now()), position);
      update();
    });
    const ok = el("button", { class: "primary", "data-testid": "promotion-ok" }, "Promote");
    ok.addEventListener("click", () => {
      this.dialog.close();
      onPromote(promote(o, chosen)!);
    });
    const cancel = el("button", { "data-testid": "promotion-cancel" }, "Cancel");
    cancel.addEventListener("click", () => this.dialog.close());
    head.append(
      el(
        "div",
        {},
        el("b", {}, o.name),
        el("p", { class: "dim" }, `${post.label}, level ${o.level} → ${o.level + 1}`),
        el("p", {}, `The new level trains one stat (+${TRAINING_PCT}% before the post's emphasis):`),
      ),
    );
    this.dialog.replaceChildren(
      el("h2", {}, "Promotion"),
      head,
      list,
      now,
      after,
      el("div", { class: "actions" }, random, ok, cancel),
    );
    update();
    if (!this.dialog.open) this.dialog.showModal();
  }
}

/**
 * One officer in a dialog (campaigns, the roster's posts): portrait, name, post, level, traits and training are
 * edited on a copy; Apply hands it back, Cancel or ✕ drops the changes. Level up… opens the promotion dialog.
 */
export class OfficerDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly portraits = new PortraitDialog();
  private readonly promotions = new PromotionDialog();

  constructor(private readonly nameStyle: () => string = () => MIXED) {
    this.dialog = el("dialog", {
      class: "ed-dialog roster-dialog",
      "data-testid": "officer-edit",
    }) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  open(o: Officer, onSave: (o: Officer) => void, title = "Officer"): void {
    let work = structuredClone(o);
    const render = () => {
      const card = officerCard(work, {
        portraits: this.portraits,
        promotions: this.promotions,
        nameStyle: this.nameStyle,
        update: (patch) => {
          work = { ...work, ...patch };
          render();
        },
      });
      const apply = el("button", { class: "primary", "data-testid": "officer-edit-apply" }, "Apply");
      apply.addEventListener("click", () => {
        this.dialog.close();
        onSave(work);
      });
      const cancel = el("button", { "data-testid": "officer-edit-cancel" }, "Cancel");
      cancel.addEventListener("click", () => this.dialog.close());
      this.dialog.replaceChildren(el("h2", {}, title), card, el("div", { class: "actions" }, apply, cancel));
    };
    render();
    if (!this.dialog.open) this.dialog.showModal();
  }
}

import type { BattleReport, ShipReport, Side } from "../sim/scenario/report";
import { el } from "./editor/dom";

/**
 * After-action report (docs/battle-report.md): how the battle went over time, every ship's part in it, and
 * the moments that decided it.
 */

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)} %`;

const FATE: Record<ShipReport["fate"], string> = {
  destroyed: "destroyed",
  escaped: "jumped out",
  retreating: "retreating",
  disabled: "disabled",
  fighting: "still fighting",
};

const SIDE: Record<Side, string> = { yours: "Your ships", ally: "Allies", enemy: "Enemy" };

/** Both sides' hull over time, as a share of what they started with. */
function strengthChart(r: BattleReport): SVGElement {
  const W = 560;
  const H = 150;
  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const root = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "report-chart",
    role: "img",
    "aria-label": "Hull left on each side over time",
    "data-testid": "report-chart",
  });
  const T = Math.max(1, r.time, ...r.strength.map((s) => s.t));
  const x = (t: number) => pad.l + (t / T) * (W - pad.l - pad.r);
  const y = (f: number) => pad.t + (1 - f) * (H - pad.t - pad.b);
  for (const f of [0, 0.5, 1]) {
    root.append(svg("line", { x1: pad.l, x2: W - pad.r, y1: y(f), y2: y(f), class: "grid" }));
    const label = svg("text", { x: pad.l - 4, y: y(f) + 4, "text-anchor": "end" });
    label.textContent = `${f * 100}%`;
    root.append(label);
  }
  const end = svg("text", { x: W - pad.r, y: H - 4, "text-anchor": "end" });
  end.textContent = clock(T);
  root.append(end);
  for (const [key, cls] of [
    ["yours", "yours"],
    ["enemy", "enemy"],
  ] as const) {
    const pts = r.strength.map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
    if (pts) root.append(svg("polyline", { points: pts, class: `line ${cls}` }));
  }
  for (const e of r.events)
    if (e.kind === "destroyed" || e.kind === "escaped")
      root.append(svg("line", { x1: x(e.t), x2: x(e.t), y1: pad.t, y2: H - pad.b, class: `mark ${e.kind}` }));
  return root;
}

function shipTable(ships: readonly ShipReport[]): HTMLElement {
  const head = el(
    "tr",
    {},
    ...[
      "Ship",
      "Hull",
      "Dealt",
      "Taken",
      "Kills",
      "Gunnery",
      "Fuel",
      "Ammo",
      "Outcome",
      "AI spent its time",
    ].map((h) => el("th", {}, h)),
  );
  const rows = ships.map((s) =>
    el(
      "tr",
      { "data-testid": `report-ship-${s.id}`, class: s.fate },
      el("td", {}, s.name),
      el("td", { class: s.hull < 0.25 ? "alert" : "" }, pct(s.hull)),
      el("td", {}, Math.round(s.dealt).toString()),
      el("td", {}, Math.round(s.taken).toString()),
      el("td", {}, s.kills ? s.kills.toString() : ""),
      el("td", {}, s.accuracy === null ? "" : `${s.shots} · ${pct(s.accuracy)}`),
      el("td", { class: s.fuel < 0.1 ? "alert" : "" }, pct(s.fuel)),
      el("td", { class: s.ammo !== null && s.ammo < 0.1 ? "alert" : "" }, s.ammo === null ? "" : pct(s.ammo)),
      el(
        "td",
        {},
        `${FATE[s.fate]}${s.fateAt !== null ? ` at ${clock(s.fateAt)}` : ""}${s.killedBy ? ` by ${s.killedBy}` : ""}`,
      ),
      el("td", { class: "dim" }, s.behaviours.map((b) => `${b.behaviour} ${pct(b.share)}`).join(", ")),
    ),
  );
  return el("table", { class: "report-table" }, el("thead", {}, head), el("tbody", {}, ...rows));
}

export interface ReportActions {
  /** Watch the replay of this battle. */
  readonly watch?: () => void;
  /** Save the replay as a file. */
  readonly download?: () => void;
}

export class ReportDialog {
  private readonly dialog: HTMLDialogElement;

  constructor() {
    this.dialog = el("dialog", {
      class: "ed-dialog report-dialog",
      "data-testid": "report-dialog",
    }) as HTMLDialogElement;
    document.body.append(this.dialog);
  }

  get open(): boolean {
    return this.dialog.open;
  }

  show(r: BattleReport, actions: ReportActions = {}): void {
    const won = r.status === "won";
    const sections: HTMLElement[] = [];
    for (const side of ["yours", "ally", "enemy"] as const) {
      const ships = r.ships.filter((s) => s.side === side);
      if (ships.length) sections.push(el("h3", {}, SIDE[side]), shipTable(ships));
    }
    const timeline = el(
      "ol",
      { class: "report-timeline", "data-testid": "report-timeline" },
      ...r.events.map((e) => el("li", { class: e.kind }, el("b", {}, clock(e.t)), ` ${e.text}`)),
    );
    const buttons: HTMLElement[] = [];
    const btn = (label: string, testid: string, f: () => void) => {
      const b = el("button", { "data-testid": testid }, label);
      b.addEventListener("click", f);
      buttons.push(b);
    };
    if (actions.watch)
      btn("Watch replay", "report-watch", () => {
        this.dialog.close();
        actions.watch!();
      });
    if (actions.download) btn("Save replay file", "report-download", actions.download);
    btn("Close", "report-close", () => this.dialog.close());
    this.dialog.replaceChildren(
      el(
        "h2",
        { class: won ? "won" : r.status === "lost" ? "lost" : "" },
        `${r.scenario}: ${won ? "victory" : r.status === "lost" ? "defeat" : "in progress"}`,
      ),
      el("p", {}, `${r.reason || "The battle was left before it ended."} · ${clock(r.time)}`),
      el("h3", {}, "Hull left over time"),
      el(
        "p",
        { class: "dim report-legend" },
        el("span", { class: "yours" }, "━ your side"),
        " ",
        el("span", { class: "enemy" }, "━ enemy"),
        " · marks: ships lost or gone",
      ),
      strengthChart(r),
      ...sections,
      el("h3", {}, "Timeline"),
      r.events.length ? timeline : el("p", { class: "dim" }, "Nothing happened."),
      el("div", { class: "actions" }, ...buttons),
    );
    if (!this.dialog.open) this.dialog.showModal();
  }

  close(): void {
    this.dialog.close();
  }
}
